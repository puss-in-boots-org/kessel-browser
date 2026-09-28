// Just enough of the zip format for extensions: reading the zip inside a
// store's .crx (and a plain .zip), and writing one to hand in to a store.
// Stored and deflated entries only -- what extension packages use -- with
// flate2, which Kessel has anyway, doing the (de)compressing.

use flate2::read::DeflateDecoder;
use flate2::write::DeflateEncoder;
use flate2::{Compression, Crc};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};

// Limits against a package that unpacks into something enormous.
const MAX_ENTRIES: usize = 50_000;
const MAX_TOTAL: u64 = 512 * 1024 * 1024;

fn u16_at(b: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_le_bytes(b.get(at..at + 2)?.try_into().ok()?))
}

fn u32_at(b: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(b.get(at..at + 4)?.try_into().ok()?))
}

// A zip entry's name as a path inside the folder it unpacks into -- None
// for one that would land outside it (an absolute path, a drive, "..").
pub(crate) fn safe_path(name: &str) -> Option<PathBuf> {
    let name = name.replace('\\', "/");
    let mut out = PathBuf::new();
    for part in Path::new(&name).components() {
        match part {
            Component::Normal(p) => {
                let p = p.to_str()?;
                // Windows' reserved device names and a trailing dot or space
                // don't name the file they seem to.
                let stem = p.split('.').next().unwrap_or("").to_ascii_uppercase();
                if p.ends_with('.') || p.ends_with(' ') || ["CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "LPT1", "LPT2", "LPT3"].contains(&stem.as_str()) || p.contains(':') {
                    return None;
                }
                out.push(p);
            }
            Component::CurDir => {}
            _ => return None,
        }
    }
    (!out.as_os_str().is_empty()).then_some(out)
}

// Unpacks zip `data` into folder `into` (which is created).
pub fn unpack(data: &[u8], into: &Path) -> Result<(), String> {
    // The end-of-central-directory record: the last thing in the file,
    // before a comment of up to 64 KB.
    let floor = data.len().saturating_sub(22 + 65_535);
    let end = (floor..data.len().saturating_sub(21)).rev().find(|&i| u32_at(data, i) == Some(0x0605_4b50)).ok_or("not a zip file")?;
    let count = u16_at(data, end + 10).ok_or("damaged zip")? as usize;
    let mut at = u32_at(data, end + 16).ok_or("damaged zip")? as usize;
    if count > MAX_ENTRIES {
        return Err("too many files in the package".into());
    }
    std::fs::create_dir_all(into).map_err(|e| e.to_string())?;
    let mut total = 0u64;
    for _ in 0..count {
        if u32_at(data, at) != Some(0x0201_4b50) {
            return Err("damaged zip".into());
        }
        let method = u16_at(data, at + 10).ok_or("damaged zip")?;
        let crc = u32_at(data, at + 16).ok_or("damaged zip")?;
        let packed = u32_at(data, at + 20).ok_or("damaged zip")? as usize;
        let size = u32_at(data, at + 24).ok_or("damaged zip")? as u64;
        let name_len = u16_at(data, at + 28).ok_or("damaged zip")? as usize;
        let extra_len = u16_at(data, at + 30).ok_or("damaged zip")? as usize;
        let comment_len = u16_at(data, at + 32).ok_or("damaged zip")? as usize;
        let local = u32_at(data, at + 42).ok_or("damaged zip")? as usize;
        let name = String::from_utf8_lossy(data.get(at + 46..at + 46 + name_len).ok_or("damaged zip")?).into_owned();
        at += 46 + name_len + extra_len + comment_len;
        if packed == u32::MAX as usize || size == u32::MAX as u64 {
            return Err("zip64 packages aren't supported".into());
        }
        total += size;
        if total > MAX_TOTAL {
            return Err("the package unpacks into too much".into());
        }
        if name.ends_with('/') || name.ends_with('\\') {
            if let Some(dir) = safe_path(&name) {
                std::fs::create_dir_all(into.join(dir)).map_err(|e| e.to_string())?;
            }
            continue;
        }
        let Some(path) = safe_path(&name) else { return Err(format!("unsafe file name in the package: {name}")) };
        if u32_at(data, local) != Some(0x0403_4b50) {
            return Err("damaged zip".into());
        }
        let start = local + 30 + u16_at(data, local + 26).ok_or("damaged zip")? as usize + u16_at(data, local + 28).ok_or("damaged zip")? as usize;
        let raw = data.get(start..start + packed).ok_or("damaged zip")?;
        let mut bytes = Vec::with_capacity(size as usize);
        match method {
            0 => bytes.extend_from_slice(raw),
            8 => {
                DeflateDecoder::new(raw).take(size + 1).read_to_end(&mut bytes).map_err(|e| format!("{name}: {e}"))?;
            }
            m => return Err(format!("{name}: unsupported compression ({m})")),
        }
        if bytes.len() as u64 != size {
            return Err(format!("{name}: wrong size"));
        }
        let mut check = Crc::new();
        check.update(&bytes);
        if check.sum() != crc {
            return Err(format!("{name}: damaged (checksum)"));
        }
        let target = into.join(path);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(&target, bytes).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// Zips folder `dir` (everything in it, `skip` names left out at any depth).
pub fn pack(dir: &Path, skip: &[&str]) -> Result<Vec<u8>, String> {
    fn files(root: &Path, dir: &Path, skip: &[&str], out: &mut Vec<(String, PathBuf)>) -> std::io::Result<()> {
        let mut entries: Vec<_> = std::fs::read_dir(dir)?.filter_map(|e| e.ok()).collect();
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            let name = entry.file_name().to_string_lossy().into_owned();
            if skip.contains(&name.as_str()) {
                continue;
            }
            let path = entry.path();
            if entry.file_type()?.is_dir() {
                files(root, &path, skip, out)?;
            } else {
                let rel = path.strip_prefix(root).unwrap_or(&path).to_string_lossy().replace('\\', "/");
                out.push((rel, path));
            }
        }
        Ok(())
    }
    let mut list = Vec::new();
    files(dir, dir, skip, &mut list).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    let mut central = Vec::new();
    // 1 January 2000, 00:00 -- stores don't care about the dates.
    let (time, date) = (0u16, (20u16 << 9) | (1 << 5) | 1);
    for (name, path) in &list {
        let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
        let mut crc = Crc::new();
        crc.update(&bytes);
        let mut encoder = DeflateEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(&bytes).map_err(|e| e.to_string())?;
        let packed = encoder.finish().map_err(|e| e.to_string())?;
        let offset = out.len() as u32;
        let header = |sig: u32, central: bool| {
            let mut h = Vec::new();
            h.extend(sig.to_le_bytes());
            if central {
                h.extend(20u16.to_le_bytes()); // made by
            }
            h.extend(20u16.to_le_bytes()); // needed to extract
            h.extend(0x0800u16.to_le_bytes()); // UTF-8 names
            h.extend(8u16.to_le_bytes()); // deflate
            h.extend(time.to_le_bytes());
            h.extend(date.to_le_bytes());
            h.extend(crc.sum().to_le_bytes());
            h.extend((packed.len() as u32).to_le_bytes());
            h.extend((bytes.len() as u32).to_le_bytes());
            h.extend((name.len() as u16).to_le_bytes());
            h.extend(0u16.to_le_bytes()); // extra
            if central {
                h.extend(0u16.to_le_bytes()); // comment
                h.extend(0u16.to_le_bytes()); // disk
                h.extend(0u16.to_le_bytes()); // internal attributes
                h.extend(0u32.to_le_bytes()); // external attributes
                h.extend(offset.to_le_bytes());
            }
            h.extend(name.as_bytes());
            h
        };
        out.extend(header(0x0403_4b50, false));
        out.extend(&packed);
        central.extend(header(0x0201_4b50, true));
    }
    let start = out.len() as u32;
    out.extend(&central);
    out.extend(0x0605_4b50u32.to_le_bytes());
    out.extend([0u8; 4]); // disks
    out.extend((list.len() as u16).to_le_bytes());
    out.extend((list.len() as u16).to_le_bytes());
    out.extend((central.len() as u32).to_le_bytes());
    out.extend(start.to_le_bytes());
    out.extend(0u16.to_le_bytes());
    Ok(out)
}

// --- .crx -------------------------------------------------------------------

// What a .crx holds: the zip, and the signing keys it names (DER public
// keys) with the extension id they make.
pub struct Crx<'a> {
    pub zip: &'a [u8],
    pub keys: Vec<Vec<u8>>,
    // CRX3's signed extension id (16 bytes), when it has one.
    pub id: Option<Vec<u8>>,
}

// Reads protobuf field `(number, bytes)` pairs of the length-delimited kind
// -- all CRX3's header uses.
fn proto_fields(mut b: &[u8]) -> Vec<(u64, &[u8])> {
    fn varint(b: &mut &[u8]) -> Option<u64> {
        let mut v = 0u64;
        for shift in (0..64).step_by(7) {
            let (&byte, rest) = b.split_first()?;
            *b = rest;
            v |= ((byte & 0x7f) as u64) << shift;
            if byte & 0x80 == 0 {
                return Some(v);
            }
        }
        None
    }
    let mut out = Vec::new();
    while let Some(key) = varint(&mut b) {
        match key & 7 {
            2 => {
                let Some(len) = varint(&mut b) else { break };
                let Some(value) = b.get(..len as usize) else { break };
                out.push((key >> 3, value));
                b = &b[len as usize..];
            }
            0 => {
                if varint(&mut b).is_none() {
                    break;
                }
            }
            _ => break,
        }
    }
    out
}

pub fn read_crx(data: &[u8]) -> Result<Crx<'_>, String> {
    if data.get(..4) != Some(b"Cr24") {
        // A plain zip (an unpacked extension zipped up) is fine too.
        if data.get(..4) == Some(&[0x50, 0x4b, 0x03, 0x04]) {
            return Ok(Crx { zip: data, keys: Vec::new(), id: None });
        }
        return Err("not an extension package".into());
    }
    match u32_at(data, 4) {
        Some(3) => {
            let header_len = u32_at(data, 8).ok_or("damaged package")? as usize;
            let header = data.get(12..12 + header_len).ok_or("damaged package")?;
            let mut keys = Vec::new();
            let mut id = None;
            for (field, value) in proto_fields(header) {
                match field {
                    // AsymmetricKeyProof { public_key = 1, signature = 2 }
                    2 | 3 => keys.extend(proto_fields(value).into_iter().filter(|(f, _)| *f == 1).map(|(_, k)| k.to_vec())),
                    // SignedData { crx_id = 1 }
                    10000 => id = proto_fields(value).into_iter().find(|(f, _)| *f == 1).map(|(_, v)| v.to_vec()),
                    _ => {}
                }
            }
            Ok(Crx { zip: data.get(12 + header_len..).ok_or("damaged package")?, keys, id })
        }
        Some(2) => {
            let key_len = u32_at(data, 8).ok_or("damaged package")? as usize;
            let sig_len = u32_at(data, 12).ok_or("damaged package")? as usize;
            let key = data.get(16..16 + key_len).ok_or("damaged package")?.to_vec();
            Ok(Crx { zip: data.get(16 + key_len + sig_len..).ok_or("damaged package")?, keys: vec![key], id: None })
        }
        _ => Err("unknown package version".into()),
    }
}

// The extension id a public key makes: the first 16 bytes of its SHA-256,
// each half-byte written as a letter a-p.
pub fn id_of_key(key: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    id_of_bytes(&Sha256::digest(key)[..16])
}

pub fn id_of_bytes(bytes: &[u8]) -> String {
    bytes.iter().flat_map(|b| [b >> 4, b & 15]).map(|n| (b'a' + n) as char).collect()
}

impl Crx<'_> {
    // The key the extension's id comes from: the one matching the signed id
    // (a store-published package names the developer's key and the store's).
    pub fn id_key(&self) -> Option<&[u8]> {
        match &self.id {
            Some(id) => self.keys.iter().find(|k| id_of_key(k) == id_of_bytes(id)).map(|k| k.as_slice()),
            None => self.keys.first().map(|k| k.as_slice()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("kessel-zip-test-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn packs_and_unpacks_a_folder() {
        let src = temp("src");
        std::fs::create_dir_all(src.join("js")).unwrap();
        std::fs::write(src.join("manifest.json"), br#"{"name":"t"}"#).unwrap();
        std::fs::write(src.join("js/a.js"), "console.log('é');".repeat(100)).unwrap();
        std::fs::write(src.join(".DS_Store"), "x").unwrap();
        let zip = pack(&src, &[".DS_Store"]).unwrap();
        let out = temp("out");
        unpack(&zip, &out).unwrap();
        assert_eq!(std::fs::read(out.join("manifest.json")).unwrap(), br#"{"name":"t"}"#);
        assert_eq!(std::fs::read_to_string(out.join("js/a.js")).unwrap(), "console.log('é');".repeat(100));
        assert!(!out.join(".DS_Store").exists());
        let _ = std::fs::remove_dir_all(src);
        let _ = std::fs::remove_dir_all(out);
    }

    #[test]
    fn refuses_names_that_leave_the_folder() {
        for name in ["../evil.js", "/etc/x", "C:/x", "a/../../b", "con.txt", "x:y"] {
            assert!(safe_path(name).is_none(), "{name}");
        }
        assert_eq!(safe_path("a/b.js"), Some(PathBuf::from("a").join("b.js")));
    }

    #[test]
    fn ids_come_from_keys() {
        assert_eq!(id_of_bytes(&[0x01, 0xf0]), "abpa");
        assert_eq!(id_of_key(b"").len(), 32);
    }

    #[test]
    fn reads_a_crx3_header() {
        // CrxFileHeader { sha256_with_rsa { public_key: "KEY" }, signed_header_data: SignedData { crx_id } }
        use sha2::{Digest, Sha256};
        let key = b"KEY".to_vec();
        let id = Sha256::digest(&key)[..16].to_vec();
        let proof = [vec![0x0a, key.len() as u8], key.clone()].concat();
        let signed = [vec![0x0a, 16], id.clone()].concat();
        let header = [vec![0x12, proof.len() as u8], proof, vec![0x82, 0xf1, 0x04, signed.len() as u8], signed].concat();
        let crx = [b"Cr24".to_vec(), 3u32.to_le_bytes().to_vec(), (header.len() as u32).to_le_bytes().to_vec(), header, b"PK\x05\x06".to_vec()].concat();
        let parsed = read_crx(&crx).unwrap();
        assert_eq!(parsed.id_key(), Some(&b"KEY"[..]));
        assert_eq!(parsed.zip, b"PK\x05\x06");
    }
}
