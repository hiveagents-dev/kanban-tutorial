// The SDK accepts a single permission and context policy per definition. Keep these
// provider-specific profiles separate so auto routing never widens their authority.
const optionsByProvider = new Map([
  ['claude', () => ({
    permissions: { mode: 'respond' },
    context: { profile: 'clean', memory: 'off' },
    providerOptions: { claude: { systemPromptMode: 'replace', tools: [] } },
  })],
  ['codex', () => ({
    permissions: { mode: 'analyze', minimumEnforcement: 'sandbox' },
    context: { profile: 'native', memory: 'off' },
    providerOptions: { codex: { skipGitRepoCheck: true, ignoreRules: true, ignoreUserConfig: true, ephemeral: true } },
  })],
]);

function profile(runtime, provider, explicitModel) {
  const options = optionsByProvider.get(provider);
  if (!options) return undefined;
  const registration = runtime.registration(provider);
  const structured = registration.execCapabilities?.structuredOutput;
  if (structured === 'unsupported' || structured === 'partial') return undefined;
  const candidates = explicitModel === undefined
    ? registration.modelCatalog.map(model => provider + '/' + model.id)
    : [explicitModel];
  if (!candidates.length) return undefined;
  return { provider, options: options(), candidates, explicit: explicitModel !== undefined };
}

export function boardRoutingProfiles(runtime, model) {
  if (model && model !== 'auto') {
    const { provider, id } = runtime.resolveModel(model);
    const found = profile(runtime, provider, provider + '/' + id);
    if (!found) throw new Error('Este tablero necesita schema nativo y permisos de respuesta o solo lectura. Elegí Claude o Codex.');
    return [found];
  }
  const registered = new Set(runtime.providers());
  return [...optionsByProvider.keys()]
    .filter(provider => registered.has(provider))
    .map(provider => profile(runtime, provider))
    .filter(Boolean);
}

export function boardRoutingDefinition(profile, options) {
  return {
    ...options, ...profile.options, transport: 'exec',
    model: {
      mode: 'auto', providers: [profile.provider], allowUnverifiedModels: true,
      ...(profile.explicit ? { candidates: profile.candidates } : {}),
    },
  };
}
