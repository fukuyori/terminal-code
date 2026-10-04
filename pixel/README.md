# Pixel
A library for building graphical applications that can run in the terminal


```
npm install @zenbu-labs/pixel
```

## Notable features:
- A react API to use a rust based graphics engine that runs in the terminal
- WebView component that lets you render web content (based on top of a fork of electron)
- Support for proxying network requests made by the webview over an SSH connection
- Can be embedded inside other terminal applications
- Built in devtools (element inspector, profiler, log viewer)

## Projects using pixel
- [terminal-browser](https://github.com/zenbu-labs/terminal-browser) - a browser inside the terminal
- [terminal-code](https://github.com/zenbu-labs/terminal-code) - vscode inside the terminal


## Documentation
Documentation is WIP. You can find examples of many usage patterns inside [`examples`](examples). For advanced usage you can reference the above projects that use pixel in production. 

### Windows console attachment

`attachWindowsConsole(pid)` from `@zenbu-labs/pixel/terminal` attaches the current
process to a live Windows process's console. A detached bridge can use it before
its launcher exits, then give its own PID to an embedded engine through
`TERMINAL_BROWSER_CONSOLE_PID`. It throws if the PID is invalid, attachment fails,
or a Pixel terminal already owns this process's console. It does not enable raw
input, start a renderer, or reserve an engine session. Build the native package
along with the TypeScript package when using this API.
