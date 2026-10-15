# create-bare-game

Create a new [Bare Engine](https://github.com/bare-engine/bare-engine) game.

```
npm create bare-game@latest
```

Also works with `pnpm create bare-game`, `yarn create bare-game` and `bun create bare-game`.

The CLI downloads the latest release of [bare-template](https://github.com/bare-engine/bare-template), sets the project name in `package.json`, and optionally runs `git init` and installs dependencies.

## Options

Pass a folder name to skip that question:

```
npm create bare-game@latest my-game
```

Options after `--` go to the CLI:

```
npm create bare-game@latest my-game -- --yes --no-git
```

| Option | Use |
| --- | --- |
| `--ref <tag\|branch>` | Template version to use. Default: latest release, or `main` if there is none. |
| `--from <file>` | Use a local `.tar.gz` of the template instead of downloading. |
| `--no-git` | Don't run `git init`. |
| `--no-install` | Don't install dependencies. |
| `-y`, `--yes` | Accept all defaults without asking. |

## Developing

The CLI is a single file, `index.js`, with no dependencies. Requires Node 18+.

Test against a local copy of the template:

```
cd ../BareTemplate
git archive --format=tar.gz --prefix=bare-template/ HEAD -o ../template.tar.gz
cd ..
node BareCreateGame/index.js test-game --from template.tar.gz
```

Publish:

```
npm publish
```
