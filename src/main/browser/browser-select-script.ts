/** Runs only on a host-resolved native select in the isolated action world. */
export const SELECT_NATIVE_OPTION = `function(value) {
  if (!(this instanceof HTMLSelectElement) || this.matches(":disabled") || this.multiple) return false;
  const options = Array.from(this.options).filter(option => option.value === value && !option.disabled
    && !(option.parentElement instanceof HTMLOptGroupElement && option.parentElement.disabled));
  if (options.length !== 1) return false;
  this.value = value;
  this.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  this.dispatchEvent(new Event("change", { bubbles: true }));
  return this.value === value;
}`;

export const BROWSER_ACTION_WORLD = "ave-browser-actions";
