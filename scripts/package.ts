import { chmodSync, copyFileSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { buildUi } from '../src/server/http';

const ROOT = join(import.meta.dir, '..');
const DIST = join(ROOT, 'dist');
const TARGETS = [
  { arch: 'arm64', bun: 'bun-darwin-arm64' },
  { arch: 'x64', bun: 'bun-darwin-x64' },
] as const;

function run(cmd: string[]): string {
  const r = Bun.spawnSync(cmd, { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
  if (r.exitCode !== 0) throw new Error(`${cmd.join(' ')} failed: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

const version = run(['git', 'describe', '--always', '--dirty']);

const ui = await buildUi(join(ROOT, 'src/ui/index.html'));
const inlined: Record<string, { b64: string; type: string }> = {};
for (const [path, asset] of ui) inlined[path] = { b64: Buffer.from(asset.body).toString('base64'), type: asset.type };

const uiAssetsModule = `
const data = ${JSON.stringify(inlined)};
const decode = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer;
export async function loadUi() {
  return new Map(Object.entries(data).map(([path, a]) => [path, { body: decode(a.b64), type: a.type }]));
}
`;

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

for (const { arch, bun } of TARGETS) {
  const stage = join(DIST, `stage-${arch}`);
  mkdirSync(stage, { recursive: true });
  const binary = join(stage, 'headroom');
  const built = await Bun.build({
    entrypoints: [join(ROOT, 'src/main.ts')],
    compile: { target: bun, outfile: binary, autoloadDotenv: false, autoloadBunfig: false },
    minify: true,
    define: { HEADROOM_PACKAGED: 'true' },
    plugins: [
      {
        name: 'inline-ui',
        setup(build) {
          build.onLoad({ filter: /src[\\/]server[\\/]ui-assets\.ts$/ }, () => ({ contents: uiAssetsModule, loader: 'js' }));
        },
      },
    ],
  });
  if (!built.success) throw new AggregateError(built.logs, `${bun} build failed`);

  run(['codesign', '--force', '-s', '-', binary]);
  copyFileSync(join(ROOT, 'packaging/install.sh'), join(stage, 'install.sh'));
  chmodSync(join(stage, 'install.sh'), 0o755);
  copyFileSync(join(ROOT, 'packaging/README.md'), join(stage, 'README.md'));
  copyFileSync(join(ROOT, 'src/ui/fonts/OFL.txt'), join(stage, 'OFL.txt'));

  const tarball = join(DIST, `headroom-${version}-darwin-${arch}.tar.gz`);
  run(['tar', '-czf', tarball, '-C', stage, 'headroom', 'install.sh', 'README.md', 'OFL.txt']);
  rmSync(stage, { recursive: true });
  console.log(`${tarball} ${(statSync(tarball).size / 1e6).toFixed(1)} MB`);
}
