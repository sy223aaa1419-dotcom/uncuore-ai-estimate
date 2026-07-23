/**
 * shared-pricing.js
 * 料金の唯一の正（Single Source of Truth）
 * App.jsx と Pages Functions の両方からこのファイルを参照する
 *
 * ※ App.jsx は import できないため、料金部分をコピーしているが
 *    このファイルの数値を常に正とし、App.jsx 側を同期すること
 */

export const MENU_PRICING = {
  "Cuore russo coat":                 { durability: "5年",  new: { S: 190000, M: 211000, L: 234000, LL: 259000, "3L": 288000 }, used: { S: 201000, M: 222000, L: 244000, LL: 270000, "3L": 299000 } },
  "CERAMIC ULTRA + Original CERAMIC": { durability: "5年",  new: { S: 188000, M: 209000, L: 231000, LL: 257000, "3L": 286000 }, used: { S: 200000, M: 221000, L: 242000, LL: 268000, "3L": 297000 } },
  "HYBRID CERAMIC":                   { durability: "3年",  new: { S: 148000, M: 169000, L: 191000, LL: 217000, "3L": 246000 }, used: { S: 160000, M: 182000, L: 202000, LL: 228000, "3L": 257000 } },
  "Cuore coat":                       { durability: "3年",  new: { S: 140000, M: 155000, L: 170000, LL: 188000, "3L": 208000 }, used: { S: 151000, M: 166000, L: 181000, LL: 199000, "3L": 219000 } },
  "Original CERAMIC":                 { durability: "1年",  new: { S: 105000, M: 117000, L: 129000, LL: 139000, "3L": 151000 }, used: { S: 112000, M: 124000, L: 135000, LL: 147000, "3L": 159000 } },
  "Veloce Coating":                   { durability: "1年",  new: { S:  54000, M:  62000, L:  69000, LL:  78000, "3L":  86000 }, used: { S:  58000, M:  66000, L:  73000, LL:  82000, "3L":  92000 } },
};

export const OPTION_PRICING = {
  windAll:       { label: "ウインドコート（全面）",                   SM: 22000, LLLL3L: 26000 },
  windFront:     { label: "ウインドコート（フロント）",               SM: 13000, LLLL3L: 17000 },
  resinParts:    { label: "樹脂パーツコーティング",                   SM: 17000, LLLL3L: 24000 },
  wheelCoat:     { label: "ホイールコート（4本）",                   SM: 20000, LLLL3L: 25000 },
  roomClean:     { label: "ルームクリーニング",                       SM: 36000, LLLL3L: 42000 },
  interiorCoat:  { label: "インテリアコーティング",                   SM: 38000, LLLL3L: 44000 },
  headlightCoat: { label: "ヘッドライトコーティング（研磨込み）",     SM: 36000, LLLL3L: 38000 },
  chromeClean:   { label: "メッキモールクリーニング",                 SM: 34000, LLLL3L: 41000 },
  detailCoat:    { label: "細部コーティング",                         SM: 22000, LLLL3L: 26000 },
  deodorize:     { label: "脱臭",                                     SM:  8000, LLLL3L: 11000 },
  photocatalyst: { label: "無光触媒コーティング（24時間抗菌・消臭）", SM: 40000, LLLL3L: 48000 },
};

/** サイズグループ判定 */
export function getSizeGroup(size) {
  return ["S", "M"].includes(size) ? "SM" : "LLLL3L";
}

/** メニュー金額を計算 */
export function calcMenuPrice(menu, carAge, size) {
  const m = MENU_PRICING[menu];
  if (!m) return 0;
  return m[carAge === "new" ? "new" : "used"]?.[size] || 0;
}

/** オプション1件の金額を計算 */
export function calcOptionPrice(optionId, size) {
  const o = OPTION_PRICING[optionId];
  if (!o) return 0;
  return getSizeGroup(size) === "SM" ? o.SM : o.LLLL3L;
}

/**
 * 見積合計を再計算（サーバー側で使用）
 * @returns {{ menuPrice, menuDuration, options, optionTotal, total }}
 */
export function calcTotal(menu, carAge, size, optionIds = []) {
  const menuPrice    = calcMenuPrice(menu, carAge, size);
  const menuDuration = MENU_PRICING[menu]?.durability || "";
  const options      = optionIds
    .filter(id => OPTION_PRICING[id])
    .map(id => ({ id, label: OPTION_PRICING[id].label, price: calcOptionPrice(id, size) }));
  const optionTotal  = options.reduce((s, o) => s + o.price, 0);
  return { menuPrice, menuDuration, options, optionTotal, total: menuPrice + optionTotal };
}
