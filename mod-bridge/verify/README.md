# Offline verification harness

`BridgeVerify.java` exercises every part of the mod that does **not** need a running Minecraft
server:

* `Json` — writer/parser round-trips, escaping, unicode, number formatting, and rejection of
  malformed input.
* `AgentCommandRunner` — the operator-command whitelist: all six allowed roots, command-injection
  attempts (`\n`, `\r`, `§`, `\u0000`), the length cap and its exact boundary, and `root()`
  normalisation.
* `BridgeHttpServer` — the **real** `com.sun.net.httpserver` instance: routing, methods, status
  codes (`200/400/401/403/404/405/413/503`), `authToken` enforcement via header and query string,
  `enabled=false`, restart-after-stop, and the `BindException` (port already in use) path.

Last run: **105 checks, 0 failures.**

## Running it

From `<repo>\mod-bridge`:

```powershell
# 1. Build the mod classes (yarn-named, pre-remap).
.\gradlew.bat classes copyJar

# 2. Ask Loom for the exact compile classpath.
.\gradlew.bat -I verify\cp-init.gradle printCompileClasspath -q --console=plain |
  Out-File -Encoding utf8 verify\raw.txt
#    ...then keep only the text between CLASSPATH_START and CLASSPATH_END in verify\cp.txt

# 3. Compile and run the harness against the real classpath.
$jdk = "C:\Users\<you>\AppData\Local\Packages\Microsoft.4297127D64EC6_8wekyb3d8bbwe\LocalCache\Local\runtime\java-runtime-delta\windows-x64\java-runtime-delta"
$cp  = (Get-Content verify\cp.txt -Raw).Trim()
& "$jdk\bin\javac.exe" -encoding UTF-8 -nowarn `
    -cp "build\classes\java\main;$cp" -d "build\verify-classes" verify\BridgeVerify.java
& "$jdk\bin\java.exe" -cp "build\verify-classes;build\classes\java\main;$cp" BridgeVerify
```

Exit code is `0` when every check passes, `1` otherwise (with the failing checks listed).

## `mock-bridge.js` — offline stub for the agent-side client

`mock-bridge.js` is a throwaway Node HTTP server that answers `/health`, `/state`, `/players` and
`POST /command` with the payload shapes documented in the main README (including a `400` rejection
for a non-whitelisted command). It exists so the *client* can be exercised without a Minecraft
server:

```powershell
cd "<repo>"
node mod-bridge\verify\mock-bridge.js      # terminal 1 — binds 127.0.0.1:8765
node scripts\bridge-client.js state        # terminal 2 — prints the formatted state
```

It proves the client's parsing, formatting and error classification. It does **not** prove anything
about the mod: the payloads are hand-written, not produced by `BridgeHttpServer`.

## What it cannot cover

Anything that needs a live server: `PlayerTracker` join/leave tracking, the `MinecraftServer`
snapshot behind `/state`, whitelisted command execution, and the `!!agent` chat hook. Those require
a Fabric 1.20.1 server with Fabric API installed — see the main `README.md`.
