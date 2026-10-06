export function decryptSetting<T>(value: T, key?: string): T extends string ? string : T;
