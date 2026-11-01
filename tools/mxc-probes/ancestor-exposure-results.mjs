// Positive host control proves the attempted reads exist. Query-only grants can
// expose names recursively; record that outcome instead of treating it as isolation.
export function evaluateAncestorExposure(host, measured, descriptorUnchanged) {
  const observations = measured?.observations;
  const hostControl = host?.observations?.siblingContent?.contents === "host-only-marker"
    && host?.observations?.descendantContent?.contents === "descendant-marker";
  const contentDenied = ["siblingContent", "descendantContent"].every((label) =>
    ["EACCES", "EPERM"].includes(observations?.[label]?.error));
  const profileNameExposure = observations?.profile?.names?.includes("Documents") === true;
  const descendantObserved = Array.isArray(observations?.descendant?.names)
    || ["EACCES", "EPERM"].includes(observations?.descendant?.error);
  return { contentDenied, profileNameExposure,
    descendantEnumeration: Array.isArray(observations?.descendant?.names) ? "visible" : observations?.descendant?.error,
    accepted: hostControl && measured?.marker === "ancestor-exposure" && descriptorUnchanged === true
      && contentDenied && profileNameExposure && descendantObserved };
}
