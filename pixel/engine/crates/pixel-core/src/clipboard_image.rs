use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum PasteSource {
    Clipboard,
    Osc,
    File,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PastedImage {
    pub path: String,
    pub width: u32,
    pub height: u32,
    pub source: PasteSource,
}

static NEXT_ID: AtomicU64 = AtomicU64::new(0);

pub(crate) fn temp_path(ext: &str) -> PathBuf {
    let dir = std::env::temp_dir().join("pixel-attachments");
    let _ = std::fs::create_dir_all(&dir);
    let n = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    dir.join(format!("paste-{}-{n}.{ext}", std::process::id()))
}

fn dims(path: &Path) -> Option<(u32, u32)> {
    image::ImageReader::open(path)
        .ok()?
        .with_guessed_format()
        .ok()?
        .into_dimensions()
        .ok()
}

fn from_file(path: &Path, source: PasteSource) -> Option<PastedImage> {
    let (width, height) = dims(path)?;
    Some(PastedImage {
        path: path.to_string_lossy().into_owned(),
        width,
        height,
        source,
    })
}

pub(crate) enum WorkerPaste {
    File(PastedImage),
    Bitmap {
        pasted: PastedImage,
        rgba: image::RgbaImage,
    },
}

pub(crate) fn read_for_worker() -> Option<WorkerPaste> {
    let mut clipboard = arboard::Clipboard::new().ok()?;
    if let Ok(files) = clipboard.get().file_list()
        && let Some(pasted) = files.iter().find_map(|f| from_file(f, PasteSource::Clipboard))
    {
        return Some(WorkerPaste::File(pasted));
    }
    let img = clipboard.get_image().ok()?;
    let rgba = image::RgbaImage::from_raw(
        img.width as u32,
        img.height as u32,
        img.bytes.into_owned(),
    )?;
    let (width, height) = rgba.dimensions();
    let pasted = PastedImage {
        path: temp_path("png").to_string_lossy().into_owned(),
        width,
        height,
        source: PasteSource::Clipboard,
    };
    Some(WorkerPaste::Bitmap { pasted, rgba })
}

pub fn image_path_from_paste(text: &str) -> Option<PastedImage> {
    let trimmed = text.trim();
    if trimmed.is_empty() || trimmed.contains('\n') {
        return None;
    }
    let unquoted = trimmed.trim_matches(|c| c == '\'' || c == '"');
    let path = match unquoted.strip_prefix("file://") {
        Some(rest) => file_url_path(rest),
        None => unescape(unquoted),
    };
    let path = match path.strip_prefix("~/") {
        Some(rest) => Path::new(&home_dir()?).join(rest),
        None => PathBuf::from(path),
    };
    if !path.is_absolute() || !path.is_file() {
        return None;
    }
    from_file(&path, PasteSource::File)
}

fn home_dir() -> Option<String> {
    std::env::var("HOME")
        .ok()
        .or_else(|| std::env::var("USERPROFILE").ok())
}

fn file_url_path(path: &str) -> String {
    let decoded = percent_decode(path);
    #[cfg(windows)]
    {
        let decoded = decoded.replace('/', "\\");
        if decoded.starts_with('\\')
            && decoded.as_bytes().get(2) == Some(&b':')
            && decoded.as_bytes().get(1).is_some_and(u8::is_ascii_alphabetic)
        {
            return decoded[1..].to_owned();
        }
        decoded
    }
    #[cfg(not(windows))]
    {
        decoded
    }
}

fn unescape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            if let Some(next) = chars.next() {
                #[cfg(windows)]
                if !next.is_whitespace() && next != '\'' && next != '"' {
                    out.push(c);
                }
                out.push(next);
            }
        } else {
            out.push(c);
        }
    }
    out
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let decoded = (bytes[i] == b'%' && i + 2 < bytes.len())
            .then(|| u8::from_str_radix(&s[i + 1..i + 3], 16).ok())
            .flatten();
        match decoded {
            Some(byte) => {
                out.push(byte);
                i += 3;
            }
            None => {
                out.push(bytes[i]);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pixel-clipboard-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn temp_png(name: &str) -> PathBuf {
        let path = temp_dir().join(name);
        image::RgbaImage::from_pixel(6, 4, image::Rgba([1, 2, 3, 255]))
            .save(&path)
            .unwrap();
        path
    }

    #[test]
    fn plain_path_paste_detects_an_image() {
        let path = temp_png("plain.png");
        let pasted = image_path_from_paste(&path.to_string_lossy()).unwrap();
        assert_eq!((pasted.width, pasted.height), (6, 4));
    }

    #[test]
    fn quoted_escaped_and_file_url_paths_normalize() {
        let path = temp_png("with space.png");
        let raw = path.to_string_lossy();
        assert!(image_path_from_paste(&format!("'{raw}'")).is_some());
        assert!(image_path_from_paste(&raw.replace(' ', "\\ ")).is_some());
        let url = format!("file://{}", raw.replace(' ', "%20"));
        assert!(image_path_from_paste(&url).is_some());
    }

    #[test]
    fn ordinary_text_and_non_image_files_are_rejected() {
        assert!(image_path_from_paste("hello world").is_none());
        assert!(image_path_from_paste("/does/not/exist.png").is_none());
        assert!(image_path_from_paste("one\n/two.png").is_none());
        let path = temp_dir().join("notes.txt");
        std::fs::write(&path, "just text").unwrap();
        assert!(image_path_from_paste(&path.to_string_lossy()).is_none());
    }

    /// Writing the clipboard replaces what the person had on it, so these run
    /// only when asked for, and put back what was there.
    fn clipboard_tests_allowed() -> bool {
        std::env::var("PIXEL_TEST_CLIPBOARD").as_deref() == Ok("1")
    }

    #[test]
    fn a_picture_on_the_clipboard_comes_back_as_pixels() {
        if !clipboard_tests_allowed() {
            return;
        }
        let mut clipboard = arboard::Clipboard::new().expect("a clipboard to read");
        let kept = clipboard.get_text().ok();
        let pixels: Vec<u8> = (0..6 * 4).flat_map(|i| [i as u8, 9, 9, 255]).collect();
        clipboard
            .set_image(arboard::ImageData {
                width: 6,
                height: 4,
                bytes: pixels.into(),
            })
            .expect("to put a picture on the clipboard");

        let read = read_for_worker();
        if let Some(text) = kept {
            let _ = clipboard.set_text(text);
        }

        match read {
            Some(WorkerPaste::Bitmap { pasted, rgba }) => {
                assert_eq!((pasted.width, pasted.height), (6, 4));
                assert_eq!(rgba.dimensions(), (6, 4));
                assert_eq!(pasted.source, PasteSource::Clipboard);
                assert!(pasted.path.ends_with(".png"), "{}", pasted.path);
            }
            other => panic!("expected pixels, got {:?}", other.map(|_| "something else")),
        }
    }

    #[test]
    fn a_copied_image_file_comes_back_as_that_file() {
        if !clipboard_tests_allowed() {
            return;
        }
        let path = temp_png("copied.png");
        let mut clipboard = arboard::Clipboard::new().expect("a clipboard to read");
        let kept = clipboard.get_text().ok();
        let put = clipboard.set().file_list(&[path.clone()]);
        let read = if put.is_ok() { read_for_worker() } else { None };
        if let Some(text) = kept {
            let _ = clipboard.set_text(text);
        }
        if put.is_err() {
            // Not every platform's clipboard takes a file list; the picture
            // path above is the one that matters here.
            return;
        }

        match read {
            Some(WorkerPaste::File(pasted)) => {
                assert_eq!((pasted.width, pasted.height), (6, 4));
                assert_eq!(pasted.source, PasteSource::Clipboard);
                assert_eq!(std::path::Path::new(&pasted.path), path.as_path());
            }
            other => panic!("expected the file, got {:?}", other.map(|_| "something else")),
        }
    }
}
