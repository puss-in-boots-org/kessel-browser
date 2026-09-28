// Windows' own file dialogs (the "Open" dialog for Ctrl+O), through the
// shell's IFileOpenDialog -- the same dialog every Windows app shows.

use std::path::PathBuf;

// Filters: (name, patterns like "*.html;*.htm").
#[cfg(windows)]
pub fn open_file(owner: Option<windows::Win32::Foundation::HWND>, title: &str, filters: &[(&str, &str)]) -> Option<PathBuf> {
    use windows::core::{HSTRING, PCWSTR};
    use windows::Win32::System::Com::{CoCreateInstance, CoTaskMemFree, CLSCTX_INPROC_SERVER};
    use windows::Win32::UI::Shell::Common::COMDLG_FILTERSPEC;
    use windows::Win32::UI::Shell::{FileOpenDialog, IFileOpenDialog, SIGDN_FILESYSPATH};

    unsafe {
        let dialog: IFileOpenDialog = CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER).ok()?;
        let names: Vec<HSTRING> = filters.iter().map(|(n, _)| HSTRING::from(*n)).collect();
        let specs: Vec<HSTRING> = filters.iter().map(|(_, s)| HSTRING::from(*s)).collect();
        let spec: Vec<COMDLG_FILTERSPEC> = names
            .iter()
            .zip(specs.iter())
            .map(|(n, s)| COMDLG_FILTERSPEC { pszName: PCWSTR(n.as_ptr()), pszSpec: PCWSTR(s.as_ptr()) })
            .collect();
        if !spec.is_empty() {
            dialog.SetFileTypes(&spec).ok()?;
        }
        dialog.SetTitle(&HSTRING::from(title)).ok()?;
        // Cancelled -> an error here.
        dialog.Show(owner).ok()?;
        let item = dialog.GetResult().ok()?;
        let name = item.GetDisplayName(SIGDN_FILESYSPATH).ok()?;
        let path = name.to_string().ok();
        CoTaskMemFree(Some(name.0 as _));
        path.map(PathBuf::from)
    }
}

#[cfg(not(windows))]
pub fn open_file(_owner: Option<()>, _title: &str, _filters: &[(&str, &str)]) -> Option<PathBuf> {
    None
}

// The window a dialog belongs to.
#[cfg(windows)]
pub type Owner = windows::Win32::Foundation::HWND;
#[cfg(not(windows))]
pub type Owner = ();

// The "Select folder" dialog.
#[cfg(windows)]
pub fn pick_folder(owner: Option<Owner>, title: &str) -> Option<PathBuf> {
    use windows::core::HSTRING;
    use windows::Win32::System::Com::{CoCreateInstance, CoTaskMemFree, CLSCTX_INPROC_SERVER};
    use windows::Win32::UI::Shell::{FileOpenDialog, IFileOpenDialog, FOS_FORCEFILESYSTEM, FOS_PICKFOLDERS, SIGDN_FILESYSPATH};

    unsafe {
        let dialog: IFileOpenDialog = CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER).ok()?;
        let options = dialog.GetOptions().ok()?;
        dialog.SetOptions(options | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM).ok()?;
        dialog.SetTitle(&HSTRING::from(title)).ok()?;
        dialog.Show(owner).ok()?;
        let item = dialog.GetResult().ok()?;
        let name = item.GetDisplayName(SIGDN_FILESYSPATH).ok()?;
        let path = name.to_string().ok();
        CoTaskMemFree(Some(name.0 as _));
        path.map(PathBuf::from)
    }
}

#[cfg(not(windows))]
pub fn pick_folder(_owner: Option<Owner>, _title: &str) -> Option<PathBuf> {
    None
}

// The "Save as" dialog, suggesting `name`.
#[cfg(windows)]
pub fn save_file(owner: Option<Owner>, title: &str, name: &str, filters: &[(&str, &str)]) -> Option<PathBuf> {
    use windows::core::{HSTRING, PCWSTR};
    use windows::Win32::System::Com::{CoCreateInstance, CoTaskMemFree, CLSCTX_INPROC_SERVER};
    use windows::Win32::UI::Shell::Common::COMDLG_FILTERSPEC;
    use windows::Win32::UI::Shell::{FileSaveDialog, IFileSaveDialog, FOS_OVERWRITEPROMPT, SIGDN_FILESYSPATH};

    unsafe {
        let dialog: IFileSaveDialog = CoCreateInstance(&FileSaveDialog, None, CLSCTX_INPROC_SERVER).ok()?;
        let names: Vec<HSTRING> = filters.iter().map(|(n, _)| HSTRING::from(*n)).collect();
        let specs: Vec<HSTRING> = filters.iter().map(|(_, s)| HSTRING::from(*s)).collect();
        let spec: Vec<COMDLG_FILTERSPEC> = names.iter().zip(specs.iter()).map(|(n, s)| COMDLG_FILTERSPEC { pszName: PCWSTR(n.as_ptr()), pszSpec: PCWSTR(s.as_ptr()) }).collect();
        if !spec.is_empty() {
            dialog.SetFileTypes(&spec).ok()?;
        }
        let options = dialog.GetOptions().ok()?;
        dialog.SetOptions(options | FOS_OVERWRITEPROMPT).ok()?;
        dialog.SetTitle(&HSTRING::from(title)).ok()?;
        dialog.SetFileName(&HSTRING::from(name)).ok()?;
        if let Some((_, ext)) = name.rsplit_once('.') {
            let _ = dialog.SetDefaultExtension(&HSTRING::from(ext));
        }
        dialog.Show(owner).ok()?;
        let item = dialog.GetResult().ok()?;
        let path = item.GetDisplayName(SIGDN_FILESYSPATH).ok()?;
        let out = path.to_string().ok();
        CoTaskMemFree(Some(path.0 as _));
        out.map(PathBuf::from)
    }
}

#[cfg(not(windows))]
pub fn save_file(_owner: Option<Owner>, _title: &str, _name: &str, _filters: &[(&str, &str)]) -> Option<PathBuf> {
    None
}
