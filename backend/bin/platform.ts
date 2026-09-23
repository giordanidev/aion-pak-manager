import { existsSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';

const moduleDir = typeof __dirname !== 'undefined' ? __dirname : process.cwd();

function findProjectRoot(startDir: string): string {
	let dir = startDir;
	for (let i = 0; i < 32; i += 1) {
		if (existsSync(join(dir, 'package.json'))) {
			return dir;
		}
		const parent = dirname(dir);
		if (parent === dir) {
			break;
		}
		dir = parent;
	}
	throw new Error(`Project root not found from ${startDir}`);
}

function resolveDevRoot(): string {
	try {
		return findProjectRoot(moduleDir);
	} catch {
		return findProjectRoot(process.cwd());
	}
}

// Detecta app empacotado sem depender de `electron.app`
// (este módulo também é importado por workers).
export function isPackaged(): boolean {
	// Workers Piscina não têm `process.versions.electron`: detectar
	// empacotamento pelo path (app.asar / app.asar.unpacked).
	const normalizedModuleDir = moduleDir.replace(/\\/g, '/');
	if (normalizedModuleDir.includes('app.asar.unpacked') || normalizedModuleDir.includes('app.asar')) {
		return true;
	}
	const versions = (process as NodeJS.Process).versions as Record<string, string | undefined> | undefined;
	if (!versions || !versions.electron) {
		return false;
	}
	if ((process as NodeJS.Process & { defaultApp?: boolean }).defaultApp) {
		return false;
	}
	try {
		if (/electron/i.test(process.execPath)) {
			return false;
		}
	} catch {
		return false;
	}
	return true;
}

function resolvePackagedDataRoot(): string {
	// Portable (electron-builder): o .exe real fica em PORTABLE_EXECUTABLE_DIR;
	// process.execPath aponta para a extração temporária em %TEMP%.
	const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
	if (typeof portableDir === 'string' && portableDir.trim().length > 0) {
		return portableDir.trim();
	}
	// AppImage: process.execPath aponta para o mount read-only; os dados vão ao
	// lado do arquivo .AppImage que o usuário abriu.
	const appImage = process.env.APPIMAGE;
	if (typeof appImage === 'string' && appImage.trim().length > 0) {
		return dirname(appImage.trim());
	}
	// Linux (deb/rpm): diretório de dados do usuário, pois /opt não é gravável.
	if (process.platform === 'linux') {
		const xdg = process.env.XDG_DATA_HOME;
		const base = typeof xdg === 'string' && xdg.trim().length > 0 ? xdg.trim() : join(homedir(), '.local', 'share');
		return join(base, 'aion-pak-manager');
	}
	return dirname(process.execPath);
}

export function resolveProjectRoot(): string {
	// Empacotado: dados (/PAKS/pak, /PAKS/unpaked, /PAKS/repaked) ao lado do executável que o usuário abriu.
	if (isPackaged()) {
		return resolvePackagedDataRoot();
	}
	return resolveDevRoot();
}
