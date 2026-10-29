import fs from 'node:fs/promises';
import path from 'node:path';

export function validateFeatures(value) {
  const keys = (object, allowed) => {
    if (
      !object ||
      typeof object !== 'object' ||
      Array.isArray(object) ||
      Object.keys(object).some((key) => !allowed.includes(key))
    )
      throw new Error('Invalid client feature settings.');
  };
  keys(value, ['_comment', 'builtinProfile', 'profileImport']);
  keys(value.builtinProfile, ['_comment', 'enabled', 'displayName', 'description']);
  keys(value.profileImport, ['_comment', 'enabled']);
  if (
    typeof value.builtinProfile.enabled !== 'boolean' ||
    typeof value.profileImport.enabled !== 'boolean'
  )
    throw new Error('Client feature enabled values must be booleans.');
  for (const key of ['displayName', 'description']) {
    if (value.builtinProfile[key] !== undefined && typeof value.builtinProfile[key] !== 'string')
      throw new Error(`builtinProfile.${key} must be a string.`);
  }
  if (!value.builtinProfile.enabled && !value.profileImport.enabled)
    throw new Error('At least one of builtin profile and profile import must be enabled.');
  return {
    builtinProfile: {
      enabled: value.builtinProfile.enabled,
      displayName: value.builtinProfile.displayName?.trim() || 'Internal Tunnel',
      description: value.builtinProfile.description?.trim() || '',
    },
    profileImport: { enabled: value.profileImport.enabled },
  };
}

export async function readFeatures(root, options) {
  let value = { builtinProfile: { enabled: true }, profileImport: { enabled: true } };
  for (const file of [
    'resources/settings/client-features.json',
    'custom-config/client-features.json',
  ]) {
    try {
      const input = JSON.parse(await fs.readFile(path.join(root, file), 'utf8'));
      // Validate unknown keys before merging; missing groups inherit defaults.
      if (
        !input ||
        typeof input !== 'object' ||
        Array.isArray(input) ||
        Object.keys(input).some(
          (key) => !['_comment', 'builtinProfile', 'profileImport'].includes(key),
        )
      )
        throw new Error('Invalid client feature settings.');
      for (const key of ['builtinProfile', 'profileImport']) {
        if (
          key in input &&
          (!input[key] || typeof input[key] !== 'object' || Array.isArray(input[key]))
        )
          throw new Error(`Invalid ${key} settings.`);
      }
      value = {
        builtinProfile: { ...value.builtinProfile, ...input.builtinProfile },
        profileImport: { ...value.profileImport, ...input.profileImport },
      };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  if (options.builtinProfile) value.builtinProfile.enabled = options.builtinProfile === 'enabled';
  if (options.profileImport) value.profileImport.enabled = options.profileImport === 'enabled';
  return validateFeatures(value);
}
