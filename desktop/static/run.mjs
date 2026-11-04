// How the app starts the server. The app holds this process's stdin open for
// as long as it runs, so however the app ends, even in a crash, stdin closes
// and the server shuts down rather than staying behind holding the port. The
// event rather than a signal, since Windows has no way to send one.
process.stdin.resume();
process.stdin.on("close", () => process.emit("SIGTERM", "SIGTERM"));
await import("./dist/api.js");
