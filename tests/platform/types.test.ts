import { toPlatformKey, fromPlatformKey } from '../../src/platform/types';
import type { PlatformId } from '../../src/platform/types';

describe('toPlatformKey', () => {
    it('encodes a discord PlatformId to "discord:id"', () => {
        const pid: PlatformId = { platform: 'discord', id: '123456' };
        expect(toPlatformKey(pid)).toBe('discord:123456');
    });

    it('encodes a telegram PlatformId to "telegram:id"', () => {
        const pid: PlatformId = { platform: 'telegram', id: '789' };
        expect(toPlatformKey(pid)).toBe('telegram:789');
    });

    it('handles IDs that contain colons', () => {
        const pid: PlatformId = { platform: 'discord', id: 'a:b:c' };
        expect(toPlatformKey(pid)).toBe('discord:a:b:c');
    });
});

describe('fromPlatformKey', () => {
    it('decodes "discord:123" to { platform: "discord", id: "123" }', () => {
        const result = fromPlatformKey('discord:123');
        expect(result).toEqual({ platform: 'discord', id: '123' });
    });

    it('decodes "telegram:456" to { platform: "telegram", id: "456" }', () => {
        const result = fromPlatformKey('telegram:456');
        expect(result).toEqual({ platform: 'telegram', id: '456' });
    });

    it('handles IDs that contain colons', () => {
        const result = fromPlatformKey('discord:a:b:c');
        expect(result).toEqual({ platform: 'discord', id: 'a:b:c' });
    });

    it('returns null for empty string', () => {
        expect(fromPlatformKey('')).toBeNull();
    });

    it('returns null for string without colon', () => {
        expect(fromPlatformKey('nocolon')).toBeNull();
    });

    it('returns null for unknown platform', () => {
        expect(fromPlatformKey('slack:123')).toBeNull();
    });

    it('returns null when id portion is empty', () => {
        expect(fromPlatformKey('discord:')).toBeNull();
    });

    it('returns null when platform portion is empty', () => {
        expect(fromPlatformKey(':123')).toBeNull();
    });

    it('roundtrips with toPlatformKey', () => {
        const original: PlatformId = { platform: 'telegram', id: 'user_42' };
        const key = toPlatformKey(original);
        const decoded = fromPlatformKey(key);
        expect(decoded).toEqual(original);
    });
});
