// Runtime asset loading only. The actual template files are not inspected or modified.
const assets = import.meta.glob<string>("./templates/html/*/*/template.html", {
  query: "?raw", import: "default", eager: true,
});

export function broadcastAsset(platform: string, geo: string): string {
  const asset = assets[`./templates/html/${platform.toLowerCase()}/${geo.toUpperCase()}/template.html`];
  if (!asset) throw new Error("Для выбранных площадки и гео не найден HTML-шаблон. Выберите шаблон в конфиге и создайте новый запуск.");
  return asset;
}
