'use strict';

// Convert legacy catalog copy for display without rewriting identifiers or customer data.
function replaceBrandText(text) {
  return text.replace(/\u6a58\s*\u4e0e\s*\u674f|\u6a58\s*\u8207\s*\u674f/g, '林元元');
}

function normalizeBrandDisplay(value) {
  if (Array.isArray(value)) return value.map(normalizeBrandDisplay);
  if (!value || Object.prototype.toString.call(value) !== '[object Object]') return value;
  const product = Object.prototype.hasOwnProperty.call(value, 'price') || Array.isArray(value.specs);
  const fields = ['title', 'subtitle', 'description', 'productName', 'goodsName', 'brandName', 'shopName', 'shareTitle'];
  const result = {};
  Object.keys(value).forEach(key => {
    const item = value[key];
    result[key] = typeof item === 'string' && (fields.includes(key) || (product && key === 'name'))
      ? replaceBrandText(item)
      : normalizeBrandDisplay(item);
  });
  return result;
}

window.MallBrand = { replaceBrandText, normalizeBrandDisplay };
