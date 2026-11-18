# Headroom

Headroom is a dashboard for the Claude accounts in your CLIProxyAPI (CPA). It shows which account is serving, how much session and weekly room each has, when each window resets, and your request history. It can also claim resets and change account priority. It runs on your Mac and listens on 127.0.0.1 only.

## Before you install

- CPA runs on this Mac, on `127.0.0.1:8317` unless you override it below.
- cpa-usage-keeper is installed with Homebrew and has run at least once. Headroom reads its database and takes the CPA management key from its env file, which must hold `CPA_MANAGEMENT_KEY`. On an Intel Mac, Homebrew lives under `/usr/local`, so set `HEADROOM_ENV_FILE` and `HEADROOM_KEEPER_DB` as shown under Overrides.
- The `claude` CLI is on your PATH, so Headroom can match its version. Without it, Headroom falls back to a pinned version.

## Download and verify

Download the tarball for your Mac from the [releases page](https://github.com/kinsyudev/headroom/releases): `darwin-arm64` for Apple silicon, `darwin-x64` for Intel. GitHub Actions builds every release from the tagged commit and signs a build provenance attestation for each tarball. To check that a tarball came from that build, run:

```sh
gh attestation verify headroom-*-darwin-arm64.tar.gz --repo kinsyudev/headroom
```

To build it yourself instead, clone the repository, install [Bun](https://bun.sh) and run `bun install && bun run package`.

## Install

```sh
tar -xzf headroom-*-darwin-*.tar.gz
./install.sh
```

The binary is ad-hoc signed and not notarized. `install.sh` removes the download quarantine flag from the copy it installs, so macOS does not block it.

The script copies `headroom` to `~/.local/bin`, writes a LaunchAgent named `dev.headroom`, and starts it. It restarts Headroom after a crash, at most once every 30 seconds. Run the script again to upgrade. Each run rewrites the LaunchAgent, so set your overrides again.

Open <http://127.0.0.1:1338>.

## Overrides

Set a variable when you run `install.sh` to change a default. The script stores it in the LaunchAgent.

| Variable | Default |
| --- | --- |
| `HEADROOM_PORT` | `1338` |
| `CPA_BASE_URL` | `http://127.0.0.1:8317` |
| `HEADROOM_ENV_FILE` | `/opt/homebrew/etc/cpa-usage-keeper.env` |
| `HEADROOM_KEEPER_DB` | `/opt/homebrew/var/cpa-usage-keeper/app.db` |

For example:

```sh
CPA_BASE_URL=http://127.0.0.1:9000 ./install.sh
```

Headroom keeps its state in `~/Library/Application Support/Headroom`.

## Logs

```sh
tail -f ~/Library/Logs/headroom.log
```

## Uninstall

```sh
./install.sh --uninstall
```

This stops Headroom and removes the binary and the LaunchAgent. It keeps the state directory and the log.

## Run one Headroom per CPA

Never run two Headroom instances against one CPA. Each instance reads Anthropic usage for every account, so a second one doubles the reads and rate-limits your accounts. If you start Headroom by hand, stop the LaunchAgent first.

## License

The UI embeds the Hubot Sans Expanded font under the SIL Open Font License. `OFL.txt` holds the license.
