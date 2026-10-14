/*
 * Tailwind CSS v4 through its PostCSS plugin (web/DESIGN.md, "Libraries").
 * Keeping this file in web/ also stops Next from walking up to the
 * repository root and loading the desktop app's PostCSS setup, so the site
 * builds from its own install alone.
 */
export default { plugins: { "@tailwindcss/postcss": {} } };
