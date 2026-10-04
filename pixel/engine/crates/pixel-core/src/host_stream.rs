//! The connection a guest keeps to the owner of the terminal. Unix uses a
//! socket file; Windows has no such thing, so it uses a named pipe.

use std::io::{self, Read, Write};
use std::time::Instant;

#[cfg(not(windows))]
mod platform {
    use std::io::{self, Read, Write};
    use std::os::unix::net::UnixStream;
    use std::time::Instant;

    pub(super) struct HostStream(UnixStream);

    impl HostStream {
        pub(super) fn connect(path: &str) -> io::Result<Self> {
            Ok(Self(UnixStream::connect(path)?))
        }

        pub(super) fn read_before(&mut self, deadline: Instant, buf: &mut [u8]) -> io::Result<usize> {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err(io::ErrorKind::TimedOut.into());
            }
            self.0.set_read_timeout(Some(left))?;
            let read = self.0.read(buf);
            let _ = self.0.set_read_timeout(None);
            read
        }

        pub(super) fn read_ready(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            self.0.read(buf)
        }
    }

    impl Write for HostStream {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.0.write(buf)
        }

        fn flush(&mut self) -> io::Result<()> {
            self.0.flush()
        }
    }

    impl std::os::fd::AsFd for HostStream {
        fn as_fd(&self) -> std::os::fd::BorrowedFd<'_> {
            std::os::fd::AsFd::as_fd(&self.0)
        }
    }
}

#[cfg(windows)]
pub(crate) mod platform {
    use std::collections::VecDeque;
    use std::io::{self, Write};
    use std::sync::{Arc, Mutex};
    use std::time::Instant;

    use windows_sys::Win32::Foundation::{
        CloseHandle, ERROR_BROKEN_PIPE, ERROR_IO_PENDING, ERROR_PIPE_BUSY, HANDLE,
        INVALID_HANDLE_VALUE, WAIT_OBJECT_0,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, FILE_FLAG_OVERLAPPED, FILE_GENERIC_READ, FILE_GENERIC_WRITE, OPEN_EXISTING,
        ReadFile, WriteFile,
    };
    use windows_sys::Win32::System::IO::{GetOverlappedResult, OVERLAPPED};
    use windows_sys::Win32::System::Pipes::WaitNamedPipeW;
    use windows_sys::Win32::System::Threading::{
        CreateEventW, ResetEvent, SetEvent, WaitForSingleObject,
    };

    const CONNECT_ATTEMPT_MS: u32 = 2000;
    const CONNECT_ATTEMPTS: u32 = 5;

    /// Windows serialises reads and writes that share a synchronous handle, so
    /// a pump thread blocked on a read would hold up every send. Overlapped
    /// handles let the two directions run at once.
    pub(crate) struct Pipe {
        handle: HANDLE,
        reading: Signal,
        writing: Signal,
    }

    // SAFETY: reads use one event and writes another, so the two directions
    // never share an overlapped structure.
    #[allow(unsafe_code)]
    unsafe impl Send for Pipe {}
    // SAFETY: as above.
    #[allow(unsafe_code)]
    unsafe impl Sync for Pipe {}

    #[allow(unsafe_code)]
    impl Pipe {
        pub(crate) fn from_handle(handle: HANDLE) -> io::Result<Self> {
            Ok(Self {
                handle,
                reading: Signal::new(true)?,
                writing: Signal::new(true)?,
            })
        }

        pub(crate) fn read(&self, buf: &mut [u8]) -> io::Result<usize> {
            let mut overlapped: OVERLAPPED = new_overlapped(self.reading.0);
            // SAFETY: buf and overlapped outlive the wait below.
            let started = unsafe {
                ReadFile(
                    self.handle,
                    buf.as_mut_ptr(),
                    buf.len() as u32,
                    std::ptr::null_mut(),
                    &mut overlapped,
                )
            };
            self.finish(started, &mut overlapped)
        }

        pub(crate) fn write(&self, buf: &[u8]) -> io::Result<usize> {
            let mut overlapped: OVERLAPPED = new_overlapped(self.writing.0);
            // SAFETY: buf and overlapped outlive the wait below.
            let started = unsafe {
                WriteFile(
                    self.handle,
                    buf.as_ptr(),
                    buf.len() as u32,
                    std::ptr::null_mut(),
                    &mut overlapped,
                )
            };
            self.finish(started, &mut overlapped)
        }

        #[cfg(test)]
        pub(crate) fn connect_signal(&self) -> HANDLE {
            self.reading.0
        }

        #[cfg(test)]
        pub(crate) fn wait_overlapped(&self, overlapped: &mut OVERLAPPED) -> io::Result<()> {
            let mut moved = 0u32;
            // SAFETY: the overlapped structure and its event are still alive.
            if unsafe { GetOverlappedResult(self.handle, overlapped, &mut moved, 1) } == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        }

        /// A closed pipe reads as end of input rather than as a failure.
        fn finish(&self, started: i32, overlapped: &mut OVERLAPPED) -> io::Result<usize> {
            if started == 0 {
                let error = io::Error::last_os_error();
                match error.raw_os_error() {
                    Some(code) if code == ERROR_IO_PENDING as i32 => {}
                    Some(code) if code == ERROR_BROKEN_PIPE as i32 => return Ok(0),
                    _ => return Err(error),
                }
            }
            let mut moved = 0u32;
            // SAFETY: the overlapped structure and its event are still alive.
            let ok = unsafe { GetOverlappedResult(self.handle, overlapped, &mut moved, 1) };
            if ok == 0 {
                let error = io::Error::last_os_error();
                if error.raw_os_error() == Some(ERROR_BROKEN_PIPE as i32) {
                    return Ok(0);
                }
                return Err(error);
            }
            Ok(moved as usize)
        }
    }

    #[allow(unsafe_code)]
    impl Drop for Pipe {
        fn drop(&mut self) {
            // SAFETY: the handle came from CreateFileW or CreateNamedPipeW.
            unsafe { CloseHandle(self.handle) };
        }
    }

    fn new_overlapped(event: HANDLE) -> OVERLAPPED {
        // SAFETY: OVERLAPPED is plain data that Windows expects zeroed.
        #[allow(unsafe_code)]
        let mut overlapped: OVERLAPPED = unsafe { std::mem::zeroed() };
        overlapped.hEvent = event;
        overlapped
    }

    /// An event handle that closes with the value holding it.
    pub(crate) struct Signal(pub(crate) HANDLE);

    // SAFETY: an event handle is usable from any thread.
    #[allow(unsafe_code)]
    unsafe impl Send for Signal {}
    // SAFETY: the Windows event API is safe to call concurrently.
    #[allow(unsafe_code)]
    unsafe impl Sync for Signal {}

    #[allow(unsafe_code)]
    impl Signal {
        fn new(manual_reset: bool) -> io::Result<Self> {
            // SAFETY: an initially clear event with default security.
            let handle = unsafe {
                CreateEventW(
                    std::ptr::null(),
                    i32::from(manual_reset),
                    0,
                    std::ptr::null(),
                )
            };
            if handle.is_null() {
                return Err(io::Error::last_os_error());
            }
            Ok(Self(handle))
        }
    }

    #[allow(unsafe_code)]
    impl Drop for Signal {
        fn drop(&mut self) {
            // SAFETY: the handle came from CreateEventW and is closed once.
            unsafe { CloseHandle(self.0) };
        }
    }

    struct Incoming {
        bytes: Mutex<VecDeque<u8>>,
        closed: std::sync::atomic::AtomicBool,
        /// Stays signalled while bytes are waiting, so the same wait that
        /// watches the console can watch the host.
        ready: Signal,
    }

    pub(super) struct HostStream {
        pipe: Arc<Pipe>,
        incoming: Arc<Incoming>,
    }

    impl HostStream {
        pub(super) fn connect(path: &str) -> io::Result<Self> {
            let pipe = Arc::new(open_pipe(path)?);
            let incoming = Arc::new(Incoming {
                bytes: Mutex::new(VecDeque::new()),
                closed: std::sync::atomic::AtomicBool::new(false),
                ready: Signal::new(true)?,
            });
            let reader = Arc::clone(&pipe);
            let shared = Arc::clone(&incoming);
            std::thread::Builder::new()
                .name("pixel-host-stream".into())
                .spawn(move || pump(&reader, &shared))?;
            Ok(Self { pipe, incoming })
        }

        pub(super) fn ready_handle(&self) -> HANDLE {
            self.incoming.ready.0
        }

        #[allow(unsafe_code)]
        pub(super) fn read_before(&mut self, deadline: Instant, buf: &mut [u8]) -> io::Result<usize> {
            loop {
                let taken = self.read_ready(buf)?;
                if taken > 0 || self.incoming.closed.load(std::sync::atomic::Ordering::Acquire) {
                    return Ok(taken);
                }
                let left = deadline.saturating_duration_since(Instant::now());
                if left.is_zero() {
                    return Err(io::ErrorKind::TimedOut.into());
                }
                let millis = left.as_millis().min(u128::from(u32::MAX - 1)) as u32;
                // SAFETY: the event handle is alive for as long as self is.
                let waited = unsafe { WaitForSingleObject(self.incoming.ready.0, millis) };
                if waited != WAIT_OBJECT_0 {
                    return Err(io::ErrorKind::TimedOut.into());
                }
            }
        }

        #[allow(unsafe_code)]
        pub(super) fn read_ready(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            let mut bytes = self.incoming.bytes.lock().expect("host stream buffer");
            let taken = buf.len().min(bytes.len());
            for (slot, byte) in buf.iter_mut().zip(bytes.drain(..taken)) {
                *slot = byte;
            }
            if bytes.is_empty() && !self.incoming.closed.load(std::sync::atomic::Ordering::Acquire) {
                // SAFETY: the event handle is alive for as long as self is.
                unsafe { ResetEvent(self.incoming.ready.0) };
            }
            Ok(taken)
        }
    }

    impl Write for HostStream {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.pipe.write(buf)
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[allow(unsafe_code)]
    fn pump(reader: &Pipe, incoming: &Incoming) {
        let mut chunk = [0u8; 8192];
        loop {
            let read = reader.read(&mut chunk);
            let mut bytes = incoming.bytes.lock().expect("host stream buffer");
            match read {
                Ok(0) | Err(_) => {
                    incoming
                        .closed
                        .store(true, std::sync::atomic::Ordering::Release);
                    // SAFETY: the event outlives the pump through the Arc.
                    unsafe { SetEvent(incoming.ready.0) };
                    return;
                }
                Ok(n) => {
                    bytes.extend(&chunk[..n]);
                    // SAFETY: the event outlives the pump through the Arc.
                    unsafe { SetEvent(incoming.ready.0) };
                }
            }
        }
    }

    /// The server accepts one client at a time, so a busy pipe means someone
    /// else is mid-handshake rather than that the host is gone.
    #[allow(unsafe_code)]
    fn open_pipe(path: &str) -> io::Result<Pipe> {
        let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
        for _ in 0..CONNECT_ATTEMPTS {
            // SAFETY: wide is a null-terminated name that outlives the call.
            let handle = unsafe {
                CreateFileW(
                    wide.as_ptr(),
                    FILE_GENERIC_READ | FILE_GENERIC_WRITE,
                    0,
                    std::ptr::null(),
                    OPEN_EXISTING,
                    FILE_FLAG_OVERLAPPED,
                    std::ptr::null_mut(),
                )
            };
            if handle != INVALID_HANDLE_VALUE {
                return Pipe::from_handle(handle);
            }
            let error = io::Error::last_os_error();
            if error.raw_os_error() != Some(ERROR_PIPE_BUSY as i32) {
                return Err(error);
            }
            // SAFETY: wide is a null-terminated name that outlives the call.
            unsafe { WaitNamedPipeW(wide.as_ptr(), CONNECT_ATTEMPT_MS) };
        }
        Err(io::Error::new(
            io::ErrorKind::WouldBlock,
            format!("{path} stayed busy"),
        ))
    }
}

pub(crate) struct HostStream {
    inner: platform::HostStream,
    /// Whatever arrived after the last line, kept for the next read.
    carry: Vec<u8>,
}

impl HostStream {
    pub(crate) fn connect(path: &str) -> io::Result<Self> {
        Ok(Self {
            inner: platform::HostStream::connect(path)?,
            carry: Vec::new(),
        })
    }

    /// Reads one line without its newline, giving up after `timeout`.
    pub(crate) fn read_line(&mut self, timeout: std::time::Duration) -> io::Result<Vec<u8>> {
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(end) = self.carry.iter().position(|byte| *byte == b'\n') {
                let rest = self.carry.split_off(end + 1);
                let mut line = std::mem::replace(&mut self.carry, rest);
                line.pop();
                return Ok(line);
            }
            let mut chunk = [0u8; 4096];
            let read = self.inner.read_before(deadline, &mut chunk)?;
            if read == 0 {
                return Err(io::Error::other("the host closed the connection"));
            }
            self.carry.extend_from_slice(&chunk[..read]);
        }
    }

    /// Bytes that arrived past the last line read.
    pub(crate) fn take_carry(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.carry)
    }

    pub(crate) fn write_line(&mut self, line: &str) -> io::Result<()> {
        self.write_all(line.as_bytes())?;
        self.write_all(b"\n")?;
        self.flush()
    }

    #[cfg(windows)]
    pub(crate) fn ready_handle(&self) -> windows_sys::Win32::Foundation::HANDLE {
        self.inner.ready_handle()
    }
}

impl Read for HostStream {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if !self.carry.is_empty() {
            let taken = buf.len().min(self.carry.len());
            buf[..taken].copy_from_slice(&self.carry[..taken]);
            self.carry.drain(..taken);
            return Ok(taken);
        }
        self.inner.read_ready(buf)
    }
}

impl Write for HostStream {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.inner.write(buf)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

#[cfg(not(windows))]
impl std::os::fd::AsFd for HostStream {
    fn as_fd(&self) -> std::os::fd::BorrowedFd<'_> {
        std::os::fd::AsFd::as_fd(&self.inner)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_guest_and_a_host_trade_lines_over_the_endpoint() {
        let dir = std::env::temp_dir().join(format!("pixel-endpoint-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let mut listener = testing::Listener::bind(&dir, "trade").unwrap();
        let endpoint = listener.endpoint().to_string();
        let host = std::thread::spawn(move || {
            let mut connection = listener.accept().unwrap();
            let asked = connection.read_line().unwrap().expect("a line");
            connection.write_line(&format!("re:{asked}")).unwrap();
            connection.write_line("push").unwrap();
            asked
        });

        let mut guest = HostStream::connect(&endpoint).unwrap();
        guest.write_line("hello").unwrap();
        let first = guest.read_line(std::time::Duration::from_secs(5)).unwrap();
        assert_eq!(String::from_utf8(first).unwrap(), "re:hello");
        let second = guest.read_line(std::time::Duration::from_secs(5)).unwrap();
        assert_eq!(String::from_utf8(second).unwrap(), "push");
        assert_eq!(host.join().unwrap(), "hello");
        let _ = std::fs::remove_dir_all(&dir);
    }
}

/// Stands in for the host a guest connects to, so tests can play that side on
/// either kind of endpoint.
#[cfg(test)]
pub(crate) mod testing {
    use std::io;

    pub(crate) struct Connection {
        stream: Stream,
        carry: Vec<u8>,
    }

    impl Connection {
        /// The next line, or None once the other side is gone.
        pub(crate) fn read_line(&mut self) -> io::Result<Option<String>> {
            loop {
                if let Some(end) = self.carry.iter().position(|byte| *byte == b'\n') {
                    let rest = self.carry.split_off(end + 1);
                    let mut line = std::mem::replace(&mut self.carry, rest);
                    line.pop();
                    return Ok(Some(String::from_utf8_lossy(&line).into_owned()));
                }
                let mut chunk = [0u8; 4096];
                match self.recv(&mut chunk) {
                    Ok(0) | Err(_) => return Ok(None),
                    Ok(n) => self.carry.extend_from_slice(&chunk[..n]),
                }
            }
        }

        pub(crate) fn write_line(&mut self, line: &str) -> io::Result<()> {
            self.send(line.as_bytes())?;
            self.send(b"\n")
        }

        pub(crate) fn try_clone(&self) -> io::Result<Self> {
            Ok(Self {
                stream: clone_stream(&self.stream)?,
                carry: Vec::new(),
            })
        }

        #[cfg(not(windows))]
        fn recv(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            std::io::Read::read(&mut self.stream, buf)
        }

        #[cfg(not(windows))]
        fn send(&mut self, buf: &[u8]) -> io::Result<()> {
            use std::io::Write as _;
            self.stream.write_all(buf)?;
            self.stream.flush()
        }

        #[cfg(windows)]
        fn recv(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            self.stream.read(buf)
        }

        #[cfg(windows)]
        fn send(&mut self, buf: &[u8]) -> io::Result<()> {
            let mut sent = 0;
            while sent < buf.len() {
                match self.stream.write(&buf[sent..])? {
                    0 => return Err(io::ErrorKind::WriteZero.into()),
                    n => sent += n,
                }
            }
            Ok(())
        }
    }

    #[cfg(not(windows))]
    fn clone_stream(stream: &Stream) -> io::Result<Stream> {
        stream.try_clone()
    }

    #[cfg(windows)]
    fn clone_stream(stream: &Stream) -> io::Result<Stream> {
        Ok(std::sync::Arc::clone(stream))
    }

    #[cfg(not(windows))]
    type Stream = std::os::unix::net::UnixStream;
    #[cfg(windows)]
    type Stream = std::sync::Arc<super::platform::Pipe>;

    #[cfg(not(windows))]
    pub(crate) struct Listener {
        inner: std::os::unix::net::UnixListener,
        endpoint: String,
    }

    #[cfg(not(windows))]
    impl Listener {
        pub(crate) fn bind(directory: &std::path::Path, name: &str) -> io::Result<Self> {
            let path = directory.join(format!("{name}.sock"));
            let inner = std::os::unix::net::UnixListener::bind(&path)?;
            Ok(Self {
                inner,
                endpoint: path.to_string_lossy().into_owned(),
            })
        }

        pub(crate) fn endpoint(&self) -> &str {
            &self.endpoint
        }

        pub(crate) fn accept(&mut self) -> io::Result<Connection> {
            let (stream, _) = self.inner.accept()?;
            Ok(Connection {
                stream,
                carry: Vec::new(),
            })
        }
    }

    #[cfg(windows)]
    pub(crate) struct Listener {
        endpoint: String,
        wide: Vec<u16>,
        waiting: Option<windows_sys::Win32::Foundation::HANDLE>,
    }

    // SAFETY: a pipe instance handle is usable from any thread.
    #[cfg(windows)]
    #[allow(unsafe_code)]
    unsafe impl Send for Listener {}

    #[cfg(windows)]
    #[allow(unsafe_code)]
    impl Listener {
        pub(crate) fn bind(_directory: &std::path::Path, name: &str) -> io::Result<Self> {
            let endpoint = format!(r"\\.\pipe\pixel-test-{}-{name}", std::process::id());
            let wide: Vec<u16> = endpoint.encode_utf16().chain(std::iter::once(0)).collect();
            let waiting = Some(instance(&wide)?);
            Ok(Self {
                endpoint,
                wide,
                waiting,
            })
        }

        pub(crate) fn endpoint(&self) -> &str {
            &self.endpoint
        }

        /// Hands over the instance a client can already see and opens the next
        /// one, so the endpoint never disappears between connections.
        pub(crate) fn accept(&mut self) -> io::Result<Connection> {
            use windows_sys::Win32::Foundation::ERROR_PIPE_CONNECTED;
            use windows_sys::Win32::System::Pipes::ConnectNamedPipe;

            let handle = match self.waiting.take() {
                Some(handle) => handle,
                None => instance(&self.wide)?,
            };
            use windows_sys::Win32::Foundation::ERROR_IO_PENDING;

            let pipe = super::platform::Pipe::from_handle(handle)?;
            let mut overlapped: windows_sys::Win32::System::IO::OVERLAPPED =
                // SAFETY: OVERLAPPED is plain data that Windows expects zeroed.
                unsafe { std::mem::zeroed() };
            overlapped.hEvent = pipe.connect_signal();
            // SAFETY: the handle is an unconnected pipe instance we own, and
            // the overlapped structure outlives the wait below.
            if unsafe { ConnectNamedPipe(handle, &mut overlapped) } == 0 {
                let error = io::Error::last_os_error();
                match error.raw_os_error() {
                    Some(code) if code == ERROR_IO_PENDING as i32 => {
                        pipe.wait_overlapped(&mut overlapped)?;
                    }
                    Some(code) if code == ERROR_PIPE_CONNECTED as i32 => {}
                    _ => return Err(error),
                }
            }
            self.waiting = Some(instance(&self.wide)?);
            Ok(Connection {
                stream: std::sync::Arc::new(pipe),
                carry: Vec::new(),
            })
        }
    }

    #[cfg(windows)]
    #[allow(unsafe_code)]
    fn instance(wide: &[u16]) -> io::Result<windows_sys::Win32::Foundation::HANDLE> {
        use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
        use windows_sys::Win32::Storage::FileSystem::{FILE_FLAG_OVERLAPPED, PIPE_ACCESS_DUPLEX};
        use windows_sys::Win32::System::Pipes::{
            CreateNamedPipeW, PIPE_READMODE_BYTE, PIPE_TYPE_BYTE, PIPE_UNLIMITED_INSTANCES,
            PIPE_WAIT,
        };

        // SAFETY: wide is a null-terminated name that outlives the call.
        let handle = unsafe {
            CreateNamedPipeW(
                wide.as_ptr(),
                PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
                PIPE_UNLIMITED_INSTANCES,
                1 << 16,
                1 << 16,
                0,
                std::ptr::null(),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error());
        }
        Ok(handle)
    }
}
