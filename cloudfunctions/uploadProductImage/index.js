'use strict';

// 一次性云函数：上传小紫瓶产品图 + 更新 images + 补 categoryId
const cloud = require('wx-server-sdk');
const fs = require('fs');
const path = require('path');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async () => ({ success: false, code: 'MAINTENANCE_DISABLED', error: 'Runtime maintenance is disabled; use a separately reviewed controlled migration.' });

async function retiredMaintenance(event = {}, context) {
  const logs = [];
  try {
    // 1. 读取云函数目录内的产品图片
    const filePath = path.join(__dirname, 'product.jpg');
    const fileContent = fs.readFileSync(filePath);

    // 2. 上传到云存储
    const uploadResult = await cloud.uploadFile({
      cloudPath: 'products/xiaoziping.jpg',
      fileContent: fileContent
    });
    const fileID = uploadResult.fileID;
    logs.push('图片上传成功');

    // 3. 获取第一个分类 ID（补 categoryId）
    const catRes = await db.collection('categories').limit(1).get().catch(() => ({ data: [] }));
    const catId = (catRes.data && catRes.data[0] && catRes.data[0]._id) || '';
    if (catId) logs.push('获取分类ID: ' + catId);
    else logs.push('警告: 未找到分类');

    // 4. 更新数据库中小紫瓶的 images + categoryId
    const updateData = { images: [fileID] };
    if (catId) updateData.categoryId = catId;

    const updateResult = await db.collection('products')
      .where({ name: '小紫瓶' })
      .update({ data: updateData });

    logs.push('更新商品数: ' + updateResult.stats.updated);

    return {
      success: true,
      message: '小紫瓶产品图已上传，categoryId 已补充',
      fileID: fileID,
      categoryId: catId,
      updated: updateResult.stats.updated,
      logs: logs
    };
  } catch (err) {
    return {
      success: false,
      error: err.message || String(err),
      logs: logs
    };
  }
};
