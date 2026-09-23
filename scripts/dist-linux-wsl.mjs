// Driver WSL2 (Windows -> Linux) do Aion PAK Manager.
//
// Compila os instaladores Linux dentro de distros WSL2 e copia os artefactos de
// volta para `release/`. O trabalho real é feito pelo builder nativo
// `scripts/linux/build.sh`, que é invocado dentro de cada distro.
//
//   node scripts/dist-linux-wsl.mjs ubuntu   # Ubuntu: .deb + AppImage
//   node scripts/dist-linux-wsl.mjs fedora   # Fedora: .rpm
//   node scripts/dist-linux-wsl.mjs all      # ambas as distros
//
// Para builds diretamente em Linux (sem WSL) usa `bash scripts/linux/build.sh`.
// Distros detetadas automaticamente; override com:
//   WSL_UBUNTU_DISTRO, WSL_FEDORA_DISTRO, AION_BUILD_DIR
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const FLAVORS = {
	ubuntu: {
		title: 'Ubuntu (.deb + AppImage)',
		envKey: 'WSL_UBUNTU_DISTRO',
		match: /ubuntu/i,
		install: 'wsl -d Ubuntu-24.04 -- sudo apt-get install -y nodejs npm rsync',
		appimage: true,
	},
	fedora: {
		title: 'Fedora (.rpm)',
		envKey: 'WSL_FEDORA_DISTRO',
		match: /fedora/i,
		install: 'wsl -d FedoraLinux-44 -- sudo dnf install -y nodejs npm rsync',
		appimage: false,
	},
}

function toWslPath(winPath) {
	const resolved = path.resolve(winPath)
	const drive = resolved[0].toLowerCase()
	const rest = resolved.slice(2).replace(/\\/g, '/')
	return `/mnt/${drive}${rest}`
}

function listDistros() {
	try {
		const raw = execFileSync('wsl', ['-l', '-q'], { encoding: 'buffer' })
		const text = raw.includes(0) ? raw.toString('utf16le') : raw.toString('utf8')
		return text
			.replace(/\u0000/g, '')
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter(Boolean)
	} catch {
		return []
	}
}

function resolveDistro(flavor) {
	const override = process.env[flavor.envKey]
	if (override) return override

	const distros = listDistros()
	const match = distros.find((name) => flavor.match.test(name))
	if (match) return match

	const available = distros.length ? distros.join(', ') : 'none'
	throw new Error(
		`No WSL distro matching ${flavor.match} found (installed: ${available}).\n` +
			`Install one ("${flavor.install}") or set ${flavor.envKey}.`
	)
}

function runFlavor(name) {
	const flavor = FLAVORS[name]
	if (!flavor) throw new Error(`Unknown flavor "${name}"`)

	const appimageFlag = flavor.appimage ? ' --with-appimage' : ''

	// Já dentro de Linux: chama o builder nativo diretamente.
	if (process.platform === 'linux') {
		const args = [path.join(root, 'scripts/linux/build.sh')]
		if (flavor.appimage) args.push('--with-appimage')
		execFileSync('bash', args, { cwd: root, stdio: 'inherit' })
		return
	}

	const distro = resolveDistro(flavor)
	const projectWsl = toWslPath(root)
	console.log(`[dist-linux-wsl] ${flavor.title} -> WSL distro "${distro}"`)

	// Normaliza CRLF dos scripts no /mnt antes de executar (vêm do Windows).
	const script = `set -euo pipefail
export HOME="$(getent passwd "$(id -un)" | cut -d: -f6)"
sed -i 's/\\r$//' '${projectWsl}/scripts/linux/'*.sh 2>/dev/null || true
bash '${projectWsl}/scripts/linux/build.sh'${appimageFlag}
`
	execFileSync('wsl', ['-d', distro, '--', 'bash', '-s'], {
		input: script,
		stdio: ['pipe', 'inherit', 'inherit'],
	})
}

const arg = (process.argv[2] || 'all').toLowerCase()
const names = arg === 'all' ? Object.keys(FLAVORS) : [arg]

for (const name of names) {
	runFlavor(name)
	console.log(`[dist-linux-wsl] ${name} done`)
}
