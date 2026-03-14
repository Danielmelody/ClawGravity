/**
 * Centralized version accessor.
 *
 * Reads the version string from the root package.json once and caches it.
 * All modules that need the app version should import from here instead of
 * scattering `await import('../../package.json')` calls everywhere.
 */

import { version as pkgVersion } from '../../package.json';

/** The current ClawGravity version (from package.json). */
export const APP_VERSION: string = pkgVersion;
