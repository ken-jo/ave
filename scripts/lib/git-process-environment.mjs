export function withoutGitContext(source = process.env) {
  const environment = { ...source };
  for (const name of Object.keys(environment)) {
    if (name.startsWith("GIT_")) delete environment[name];
  }
  return environment;
}
