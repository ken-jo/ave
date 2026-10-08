const documents = import.meta.glob("../../../docs/guides/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
});

export { documents };
