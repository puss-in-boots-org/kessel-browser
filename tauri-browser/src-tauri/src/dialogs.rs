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
