const branches = new Map<HTMLElement, number>();

/** Clear only the ancestor branch that must reveal a live native page below the UI document. */
export function registerNativePageBranch(slot: HTMLElement): () => void {
  const ancestors: HTMLElement[] = [];
  for (let element: HTMLElement | null = slot; element; element = element.parentElement) {
    ancestors.push(element);
    branches.set(element, (branches.get(element) ?? 0) + 1);
    element.setAttribute("data-ave-native-branch", "");
  }
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    for (const element of ancestors) {
      const count = (branches.get(element) ?? 1) - 1;
      if (count > 0) branches.set(element, count);
      else {
        branches.delete(element);
        element.removeAttribute("data-ave-native-branch");
      }
    }
  };
}
