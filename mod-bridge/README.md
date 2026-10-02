# agent-bridge — a Fabric companion mod for the mineflayer survival agent

`agent-bridge` is a **server-side Fabric mod for Minecraft 1.20.1**. It runs inside the dedicated
server and gives the external Node.js/mineflayer bot (`AgentSteve`) two things it cannot get from
the vanilla protocol alone:

1. **A small localhost HTTP API** (`GET /health`, `GET /state`, `GET /players`, `POST /command`) so
   the agent can read *authoritative* server state — weather, time, difficulty, per-player health,
   food, inventory — and use a strictly whitelisted set of operator commands without a human typing
   into the server console.
2. **A chat relay**: when anyone (the bot or a human) types `!!agent <text>` in chat, the text is
   POSTed to the Node agent at `http://127.0.0.1:8766/command`.

Everything is localhost-only by default, the HTTP server never touches the world off the server
thread, and a busy port can never take the game server down.

---

## Toolchain versions

| Component | Version |
| --- | --- |
| Minecraft | `1.20.1` |
| Yarn mappings | `1.20.1+build.10` (`v2`) |
| Fabric Loader | `0.15.11` |
| Fabric API | `0.92.12+1.20.1` |
| Fabric Loom | `1.11.8` |
| Gradle (wrapper) | `8.14.3` |
| Java toolchain / bytecode | Java 17 target (`options.release = 17`), built with a Java 21 JDK |
| Mod version | `1.0.0` |

> **Why Java 21 and not Java 25?** Fabric Loom 1.11.8 requires a Gradle version that does not run on
> Java 25. `gradle.properties` therefore pins `org.gradle.java.home` to the Java 21 runtime that
> ships with the Minecraft launcher, and `gradlew.bat` falls back to that same runtime when
> `JAVA_HOME` is not set, so a bare `gradlew build` works from any shell.

---

## Building

From `<repo>\mod-bridge`:

```bat
cd "<repo>\mod-bridge"
gradlew clean build copyJar
```

The first build downloads Minecraft, Yarn mappings and Fabric API from
`https://maven.fabricmc.net` and `https://services.gradle.org`, then remaps them — expect several
minutes. Later builds take seconds.

The jar lands in **`mod-bridge\dist\agent-bridge-1.0.0.jar`** (that is the file the agent tooling
expects, and the path the install steps below use). `copyJar` is a separate task, so a bare
`gradlew build` refreshes `build\libs\` but leaves `dist\` at its previous contents.

| Output | Path | Produced by |
| --- | --- | --- |
| Remapped mod jar (the one you install) | `build\libs\agent-bridge-1.0.0.jar` | `build` |
| Copy for the agent tooling / install steps | `dist\agent-bridge-1.0.0.jar` | `copyJar` |

Both files are byte-identical (37,879 bytes for version 1.0.0).

If `JAVA_HOME` is unset the wrapper falls back to
`C:\Users\<you>\AppData\Local\Packages\Microsoft.4297127D64EC6_8wekyb3d8bbwe\LocalCache\Local\runtime\java-runtime-delta\windows-x64\java-runtime-delta`.
To build on another machine, set `JAVA_HOME` to a JDK 17–21 and adjust `org.gradle.java.home` in
`gradle.properties` (use forward slashes — backslashes are escape characters in `.properties`).

---

## Installing into a Fabric 1.20.1 dedicated server

The mod needs a **Fabric** dedicated server; it will not load into a vanilla or Forge `server.jar`
(`fabric.mod.json` declares `environment: "server"` and the Fabric loader is a hard requirement).

Target versions: **Minecraft 1.20.1**, **Fabric Loader 0.15.11** (any 0.15.x works), **Fabric API
0.92.12+1.20.1**. Fabric API is **required**, not optional — the mod calls into it at runtime.

1. **Install the Fabric server loader.** Download the Fabric installer
   (<https://fabricmc.net/use/server/>), pick the **Server** tab, set *Minecraft Version* to
   `1.20.1` and *Loader Version* to `0.15.11`, then either
   - let the installer download the vanilla server jar into your server directory (named
     `server.jar`, or `server-1.20.1.jar` if you already had one — either name is fine), or
   - copy the generated `fabric-server-launch.jar` next to an existing `server-1.20.1.jar`.

   Equivalent headless form:

   ```bat
   java -jar fabric-installer.jar server -mcversion 1.20.1 -loader 0.15.11 -downloadMinecraft
   ```

   Run the launcher once (accept `eula=true` when it stops) so the server creates `mods\` and
   `config\`.

2. **Download Fabric API** `fabric-api-0.92.12+1.20.1.jar` from
   <https://modrinth.com/mod/fabric-api/versions> or
   <https://www.curseforge.com/minecraft/mc-mods/fabric-api>.

3. **Drop both jars into the server's `mods\` folder** — that folder is a sibling of the server jar
   (here, `<repo>\runtime\server\mods\`):

   ```
   <server dir>\
   ├─ fabric-server-launch.jar        (Fabric loader)
   ├─ server-1.20.1.jar               (or the jar the installer downloaded)
   ├─ eula.txt                        (eula=true)
   └─ mods\
      ├─ fabric-api-0.92.12+1.20.1.jar
      └─ agent-bridge-1.0.0.jar       <- copy of mod-bridge\dist\agent-bridge-1.0.0.jar
   ```

   An extra jar in `mods\` that is not a Fabric mod, or a wrong Fabric API version, shows up as a
   loader error in the log rather than a crash of the bridge.

4. **Start the server** with the Fabric launcher, not the vanilla jar:

   ```bat
   java -Xmx4G -jar fabric-server-launch.jar nogui
   ```

   On first launch the mod writes `config\agent-bridge.json` (relative to the server directory) and
   logs:

   ```
   [agent-bridge] v1.0.0 initialised — http=127.0.0.1:8765 enabled=true allowCommands=true chatPrefix='!!agent' bot='AgentSteve'
   [agent-bridge] HTTP bridge listening on http://127.0.0.1:8765
   ```

   If either line is missing, the mod did not load — check the log for a Fabric loader error and
   confirm both jars are in `mods\`.

5. **Verify from a shell** (or with the agent-side client, `node scripts\bridge-client.js health`):

   ```powershell
   Invoke-RestMethod http://127.0.0.1:8765/health
   ```

> **Not verified on a live server.** The jar has only been built and unit-checked offline here — see
> *Verification status* at the bottom. The steps above are the intended install path, not a
> procedure that has been executed end to end in this repository.

### Uninstalling

Delete the jar from `mods\` and, if you like, `config\agent-bridge.json`. Nothing is stored in the
world.

---

## Configuration — `config/agent-bridge.json`

Lives in the **server's** `config` directory (`<server dir>\config\agent-bridge.json`, e.g.
`runtime\server\config\agent-bridge.json`) — not in this repository's top-level `config\` folder.
It is written with defaults on first start and rewritten on every start, so the file always shows
every key; unknown keys are ignored and missing keys fall back to the defaults below.

```json
{
  "enabled": true,
  "bindAddress": "127.0.0.1",
  "port": 8765,
  "allowCommands": true,
  "authToken": "",
  "agentCallbackUrl": "http://127.0.0.1:8766/command",
  "chatPrefix": "!!agent",
  "botPlayerName": "AgentSteve"
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch. `false` = no HTTP server, no chat relay. |
| `bindAddress` | `127.0.0.1` | Interface to bind. Keep it on loopback. |
| `port` | `8765` | TCP port for the HTTP API. Invalid values fall back to `8765` with a warning. |
| `allowCommands` | `true` | When `false`, `POST /command` returns `403` even for whitelisted roots. |
| `authToken` | `""` | When non-empty, every request must send `X-Agent-Token: <token>` or `?token=<token>`. |
| `agentCallbackUrl` | `http://127.0.0.1:8766/command` | Where `!!agent <text>` is forwarded. |
| `chatPrefix` | `!!agent` | Chat trigger. Matching is case-insensitive. |
| `botPlayerName` | `AgentSteve` | Player the bridge acts on behalf of when running commands. |

Changes take effect on the next server start.

This `port` is the mod's own key. The agent side reads its copy from `config/server.json`
(`bridgePort`, default `8765`) — keep the two numbers in sync if you change one.

---

## HTTP API

All responses are `application/json; charset=utf-8`. Every endpoint except `/health` needs the
server to be up; before that they answer `503 {"ok":false,"error":"server not started yet"}`.

### `GET /health`

```json
{ "ok": true, "mod": "agent-bridge", "version": "1.0.0" }
```

### `GET /state`

World state, a rolling TPS estimate, and one object per online player.

```json
{
  "ok": true,
  "mod": "agent-bridge",
  "version": "1.0.0",
  "tick": 48213,
  "tps": 19.8,
  "serverPort": 25570,
  "minecraftVersion": "1.20.1",
  "hardcore": false,
  "maxPlayers": 8,
  "playerCount": 1,
  "difficulty": "normal",
  "dayTime": 5321,
  "worldTime": 5321,
  "isDay": true,
  "raining": false,
  "thundering": false,
  "rainGradient": 0,
  "overworldDimension": "minecraft:overworld",
  "onlinePlayerNames": ["AgentSteve"],
  "players": [
    {
      "name": "AgentSteve",
      "uuid": "069a79f4-44e9-4726-a5be-fca90e38aaf5",
      "dimension": "minecraft:overworld",
      "position": { "x": 12.5, "y": 64, "z": -30.2 },
      "blockPosition": { "x": 12, "y": 64, "z": -31 },
      "health": 20,
      "maxHealth": 20,
      "absorption": 0,
      "food": 17,
      "saturation": 5,
      "xpLevel": 3,
      "gamemode": "survival",
      "onGround": true,
      "pingMs": 4,
      "inventory": { "minecraft:cobblestone": 43, "minecraft:oak_log": 12, "minecraft:stone_pickaxe": 1 },
      "heldItem": "minecraft:stone_pickaxe",
      "offhandItem": "",
      "tracked": true,
      "trackedFirstSeenMs": 1735000000000
    }
  ],
  "trackedPlayers": [ /* everyone seen since server start, with last known position */ ],
  "bridge": { "running": true, "bindAddress": "127.0.0.1", "port": 8765, "allowCommands": true,
              "chatRelayed": 3, "chatRelayFailures": 0 }
}
```

Notes:

- `tick` is `MinecraftServer#getTicks()` — a monotonically increasing tick counter.
- `tps` is measured between two consecutive `/state` polls (clamped to 0–20). It is `0` until a
  second sample exists, and it reflects the *polling* interval, so poll on a steady cadence.
- `inventory` aggregates the 36 main slots plus armour and offhand into `item id -> total count`.
- `trackedPlayers` is safe even with nobody online; `players` is an empty array then.

### `GET /players`

```json
{
  "ok": true,
  "count": 1,
  "players": [
    { "name": "AgentSteve", "uuid": "...", "dimension": "minecraft:overworld",
      "position": {"x":12.5,"y":64,"z":-30.2}, "blockPosition": {"x":12,"y":64,"z":-31},
      "health": 20, "maxHealth": 20, "food": 17, "gamemode": "survival", "pingMs": 4 }
  ]
}
```

### `POST /command`

Request body:

```json
{ "command": "time set day" }
```

**Whitelist.** Only these command *roots* are accepted. Everything else is rejected with `400`
before it reaches the command dispatcher:

```
time   weather   give   tp   gamemode   say
```

Examples that work: `time set day`, `weather clear`, `give AgentSteve minecraft:diamond 3`,
`tp AgentSteve 100 64 100`, `gamemode creative AgentSteve`, `say hello`.

Examples that are rejected: `op`, `stop`, `execute`, `kill`, `ban`, `setblock`, `function`, `reload`,
and anything containing a newline or a `§`. The command is also capped at 256 characters.

Success:

```json
{
  "ok": true,
  "command": "time set day",
  "executedAs": "AgentSteve",
  "result": 1,
  "output": "Set the time to 1000"
}
```

Rejection:

```json
{
  "ok": false,
  "error": "command 'stop' is not whitelisted (allowed roots: say, tp, time, give, gamemode, weather)",
  "whitelist": ["time", "weather", "give", "tp", "gamemode", "say"]
}
```

| Status | Meaning |
| --- | --- |
| `200` | Command ran |
| `400` | Not whitelisted, malformed JSON, or the dispatcher failed |
| `401` | Bad/missing token while `authToken` is set |
| `403` | `allowCommands` is `false` |
| `405` | Wrong HTTP method |
| `413` | Body > 8 KiB |
| `500` | Timed out waiting for the server thread, or the handler threw |
| `503` | Server not started yet |

Commands run **as `botPlayerName`** when that player is online, so `@s` and relative coordinates
resolve against the bot; otherwise they run from the server console source. Output is captured and
returned instead of being broadcast to operators.

---

## Agent-side client — `scripts/bridge-client.js`

The Node side of this API lives in the repository root, not in this folder:
`<repo>\scripts\bridge-client.js` (plain CommonJS, zero dependencies, global `fetch`).
It reads the port from `config/server.json` → `bridgePort` (default `8765`) and the
`botPlayerName` it reports on is `AgentSteve`.

```powershell
cd "<repo>"
node scripts\bridge-client.js health      # GET /health
node scripts\bridge-client.js state       # GET /state  (+ bot position/health, vs 127.0.0.1:8766/status)
node scripts\bridge-client.js players     # GET /players
node scripts\bridge-client.js command "time set day"
```

It also exports `getHealth()`, `getState()`, `getPlayers()` and `sendCommand(cmd)` for use from the
agent's own code.

**The mod is optional.** On a server without it every call fails fast with
`[bridge] the agent-bridge mod is not installed ...` and the CLI exits `0` — connection refused is
the expected result on vanilla servers and must not be treated as an error.

---

## Chat relay

Anyone in game can type:

```
!!agent mine some iron
```

The mod:

1. prints `[agent-bridge] -> agent: mine some iron` back to that player,
2. asynchronously POSTs `{"command":"mine some iron"}` to `agentCallbackUrl`
   (`http://127.0.0.1:8766/command`).

The POST runs on a 2-thread daemon executor, never on the server thread, so a slow or absent Node
agent cannot stall a tick. Failures are logged as warnings and counted in `bridge.chatRelayFailures`.
The matching is case-insensitive and the prefix is configurable.

---

## Design notes

- **Server thread safety.** HTTP handlers run on the `agent-bridge-http` pool. Anything that reads
  world or entity state is wrapped in `BridgeHttpServer#submitToServer`, which calls
  `MinecraftServer#execute` and waits (5 s timeout) for the result on the HTTP thread. `submitToServer`
  short-circuits to an inline call when it is already on the server thread.
- **Failure isolation.** `HttpServer#create` throwing `BindException` (port in use) is caught,
  logged as a warning, and the bridge simply stays down — the game server is unaffected.
- **No new dependencies.** JSON is hand-written in `Json.java`; HTTP uses the JDK's
  `com.sun.net.httpserver`; the relay uses `java.net.http.HttpClient`. The only compile dependencies
  are Minecraft, Yarn mappings, Fabric Loader and Fabric API.
- **`environment: "server"`.** The mod only loads on a dedicated server.

## Source layout

```
mod-bridge/
├─ build.gradle                     Loom build (buildscript classpath, no plugin marker needed)
├─ settings.gradle                  Fabric + Maven Central + plugin portal repos
├─ gradle.properties                versions, org.gradle.java.home
├─ gradlew / gradlew.bat            Gradle 8.14.3 wrapper (bat has a JAVA_HOME fallback)
├─ LICENSE                          MIT
├─ README.md                        this file
├─ dist/                            copy of the built jar
├─ verify/                          offline verification harness (see verify/README.md)
└─ src/main/
   ├─ java/dev/agentbridge/
   │  ├─ AgentBridgeMod.java        ModInitializer: config, wiring, lifecycle events
   │  ├─ BridgeHttpServer.java      JDK HTTP server, endpoints, server-thread hop, TPS sampler
   │  ├─ ChatCommandBridge.java     !!agent chat hook + async POST to the Node agent
   │  ├─ AgentCommandRunner.java    command whitelist + execution as the bot's player
   │  ├─ CollectingCommandOutput.java  captures command output instead of broadcasting it
   │  ├─ PlayerTracker.java         join/leave tracking + /state and /players snapshots
   │  ├─ ModConfig.java             config/agent-bridge.json read/write
   │  └─ Json.java                  dependency-free JSON reader/writer
   └─ resources/fabric.mod.json     mod metadata
```

## Verification status

Verified here:

- `gradlew clean build copyJar` → **BUILD SUCCESSFUL**, and the jar lands in both
  `build\libs\` and `dist\` (currently `agent-bridge-1.0.0.jar`, 37,879 bytes, 17 entries).
- The built classes are correctly remapped to intermediary (`net/minecraft/class_3222`,
  `method_5667`, …), and `fabric.mod.json` inside the jar has `"version": "1.0.0"`,
  `"environment": "server"` and depends on `fabricloader >=0.15.0`, `minecraft ~1.20.1`,
  `java >=17`, `fabric-api *`.
- Every Yarn/Fabric API name used was checked against the actual artifacts:
  `minecraft-merged-1.20.1-net.fabricmc.yarn.1_20_1.1.20.1+build.10-v2.jar` (via `javap`) and the
  Yarn `mappings.tiny`.
- An offline harness (`verify/BridgeVerify.java`) runs the real HTTP server, the JSON
  reader/writer and the command whitelist: **105 checks, 0 failures** — including the
  port-already-in-use path, which logs
  `port 8765 is already in use ... continuing WITHOUT the HTTP bridge, the server is unaffected`
  and leaves the bridge down without throwing.

**Not verified:** the mod has never been loaded by a live Minecraft server, and the HTTP API has
never answered a real request against a running world. This machine's server install at
`runtime\server\` is a **Forge** installation (`mods\` exists but is empty, and the top-level
`config\server.json` still says `"loader": "vanilla"`) — there is no Fabric loader and no
`fabric-api` jar anywhere in it. So in-game behaviour — registration, `/state` against a live
`MinecraftServer`, command execution, and the `!!agent` chat relay — is untested, and the
agent-side client `scripts\bridge-client.js` can only be exercised on its
"mod not installed" path here. Installing Fabric Loader + Fabric API and dropping
`dist\agent-bridge-1.0.0.jar` into `mods\` is required to confirm the rest.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `port 8765 is already in use ... continuing WITHOUT the HTTP bridge` | Something else holds the port. Change `port` in the config, or stop the other process. The server keeps running either way. |
| `/state` returns `503 server not started yet` | The bridge is up but the server has not finished starting, or the bridge failed to start. Check `bridge.running` in the log. |
| `/state` returns `500 timed out ... waiting for the server thread` | The server thread is blocked (a lag spike or a stuck command). Retry. |
| `command 'x' is not whitelisted` | Only `time`, `weather`, `give`, `tp`, `gamemode`, `say` are allowed by design. |
| Chat commands do nothing | `enabled` must be `true`, the prefix must match, and the Node agent must be listening on `agentCallbackUrl`. Check for `could not reach the agent` warnings. |
| `node scripts\bridge-client.js health` prints `the agent-bridge mod is not installed` | Expected on any server without the mod (vanilla, Forge, or Fabric without the jar). Install it as above, or ignore — the agent works without it. |
| `Could not find or load main class` on `gradlew build` | `JAVA_HOME` points at Java 25. Use a JDK 17–21, or let the `gradlew.bat` fallback apply. |
