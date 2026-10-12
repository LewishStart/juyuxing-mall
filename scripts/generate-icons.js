// 林元元 · 高级图标生成器
// 风格：Lucide/Feather 线条风，1.5px 描边，圆角端点，96x96 高清 PNG
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const ICONS_DIR = path.resolve(__dirname, '../miniprogram/images/icons');

// 色彩规范
const C_TAB = '#8B7E72';     // tab bar 未选中
const C_TAB_ACTIVE = '#E8A87C'; // tab bar 选中
const C_UI = '#5C544B';      // UI 图标（比 tab 稍深，更清晰）
const C_BRAND = '#2D4A3E';   // 品牌墨绿
const C_WARM = '#E8A87C';    // 强调暖色

// 生成 SVG 字符串
function svg(paths, color = C_UI, sw = 1.5) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
}

// 所有图标定义
const icons = {
  // ── Tab Bar 图标（需要普通+激活两版）──
  home: '<path d="M3 9.5L12 3l9 6.5V20a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z"/>',
  'home-active': '<path d="M3 9.5L12 3l9 6.5V20a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z" fill="#E8A87C" fill-opacity="0.12"/>',

  category: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  'category-active': '<rect x="3" y="3" width="7" height="7" rx="1.5" fill="#E8A87C" fill-opacity="0.12"/><rect x="14" y="3" width="7" height="7" rx="1.5" fill="#E8A87C" fill-opacity="0.12"/><rect x="3" y="14" width="7" height="7" rx="1.5" fill="#E8A87C" fill-opacity="0.12"/><rect x="14" y="14" width="7" height="7" rx="1.5" fill="#E8A87C" fill-opacity="0.12"/>',

  cart: '<circle cx="8" cy="21" r="1.2"/><circle cx="19" cy="21" r="1.2"/><path d="M2.5 2.5h3l2.3 11.5a1.5 1.5 0 0 0 1.5 1.2h8.7a1.5 1.5 0 0 0 1.5-1.2L22 7H6"/>',
  'cart-active': '<circle cx="8" cy="21" r="1.2"/><circle cx="19" cy="21" r="1.2"/><path d="M2.5 2.5h3l2.3 11.5a1.5 1.5 0 0 0 1.5 1.2h8.7a1.5 1.5 0 0 0 1.5-1.2L22 7H6" fill="#E8A87C" fill-opacity="0.12"/>',

  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1"/>',
  'user-active': '<circle cx="12" cy="8" r="4" fill="#E8A87C" fill-opacity="0.12"/><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1" fill="#E8A87C" fill-opacity="0.12"/>',

  // ── UI 图标 ──
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  heart: '<path d="M19 5.5c-1.5-1.4-3.9-1.4-5.4 0L12 6.9l-1.6-1.4c-1.5-1.4-3.9-1.4-5.4 0-1.7 1.6-1.7 4.1 0 5.7L12 18.5l7-7.3c1.7-1.6 1.7-4.1 0-5.7z"/>',
  star: '<path d="M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 18.9l-5.9 3.1 1.2-6.5L2.5 9.4l6.6-.9z"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  settings: '<path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/>',
  chat: '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8z"/>',
  location: '<path d="M21 10c0 7-9 12-9 12s-9-5-9-12a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>',
  money: '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 12h.01M18 12h.01"/>',
  truck: '<path d="M1 3h15v13H1z"/><path d="M16 8h4l3 3v5h-7"/><circle cx="5.5" cy="18.5" r="2"/><circle cx="18.5" cy="18.5" r="2"/>',
  package: '<path d="M21 8l-9-5-9 5v8l9 5 9-5z"/><path d="M3 8l9 5 9-5"/><path d="M12 13v8"/>',
  shop: '<path d="M3 9l1-5h16l1 5"/><path d="M4 9v11h16V9"/><path d="M9 20v-6h6v6"/>',
  gift: '<rect x="3" y="8" width="18" height="4" rx="0.5"/><path d="M4 12v9h16v-9"/><path d="M12 8v13"/><path d="M12 8S10 2 7.5 4 12 8 12 8z"/><path d="M12 8s2-6 4.5-4S12 8 12 8z"/>',
  list: '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/>',
  return: '<path d="M3 7v6h6"/><path d="M3 13a9 9 0 1 0 3-7.7L3 7"/>',
  book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
  people: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  agent: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 11l-3 3-2-2"/>',
  handshake: '<path d="m11 17 2 2a1 1 0 1 0 3-3"/><path d="m14 14 2.5 2.5a1 1 0 1 0 3-3l-3.88-3.88a3 3 0 0 0-4.24 0l-.88.88a1 1 0 1 1-3-3l2.81-2.81a5.79 5.79 0 0 1 7.06-.87l.47.28a2 2 0 0 0 1.42.25L21 4"/><path d="m21 3 1 11h-2"/><path d="M3 3 2 14l6.5 6.5a1 1 0 1 0 3-3"/><path d="M3 4h8"/>',
  hands: '<path d="M18 11V6a2 2 0 0 0-4 0v5"/><path d="M14 10V4a2 2 0 0 0-4 0v6"/><path d="M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>',
  leaf: '<path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10z"/><path d="M2 21c0-3 1.85-5.36 5.08-6"/>',
  yinyang: '<circle cx="12" cy="12" r="9"/><path d="M12 3a4.5 4.5 0 0 1 0 9 4.5 4.5 0 0 0 0 9"/><circle cx="12" cy="7.5" r="1.2" fill="#5C544B" stroke="none"/><circle cx="12" cy="16.5" r="1.2" fill="#FDF8F3" stroke="none"/>',
};

// Tab bar 图标特殊处理：普通版用 C_TAB，激活版用 C_TAB_ACTIVE
const tabIcons = ['home', 'category', 'cart', 'user'];

async function generate() {
  let count = 0;
  for (const [name, paths] of Object.entries(icons)) {
    let color = C_UI;
    let sw = 1.5;

    if (tabIcons.includes(name)) {
      color = C_TAB;
    } else if (name.endsWith('-active')) {
      color = C_TAB_ACTIVE;
    }

    // 品牌特色图标用墨绿色
    if (['leaf', 'yinyang'].includes(name)) {
      color = C_BRAND;
    }

    const svgStr = svg(paths, color, sw);
    const outPath = path.join(ICONS_DIR, `${name}.png`);

    await sharp(Buffer.from(svgStr))
      .png()
      .toFile(outPath);

    count++;
    console.log(`  ✓ ${name}.png`);
  }
  console.log(`\n完成：${count} 个图标已生成`);
}

generate().catch(err => {
  console.error('生成失败:', err);
  process.exit(1);
});
