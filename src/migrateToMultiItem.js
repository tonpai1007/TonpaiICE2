
const { CONFIG } = require('./config');
const { Logger } = require('./logger');
const { getSheetData, appendSheetData, createSheet } = require('./googleServices');

async function migrateToMultiItemOrders() {
  try {
    Logger.info('🔄 Starting migration to multi-item order system...');
    
    // 1. Create new sheets
    try {
      await createSheet(CONFIG.SHEET_ID, 'คำสั่งซื้อ_ใหม่');
      await createSheet(CONFIG.SHEET_ID, 'รายการสินค้า');
    } catch (error) {
      Logger.warn('Sheets may already exist', error);
    }
    
    // 2. Add headers
    await appendSheetData(CONFIG.SHEET_ID, 'คำสั่งซื้อ_ใหม่!A:H', [
      ['รหัสคำสั่ง', 'วันที่', 'ลูกค้า', 'ผู้ส่ง', 'สถานะการจัดส่ง', 'สถานะการชำระ', 'ยอดรวม', 'หมายเหตุ']
    ]);
    
    await appendSheetData(CONFIG.SHEET_ID, 'รายการสินค้า!A:G', [
      ['รหัสคำสั่ง', 'สินค้า', 'จำนวน', 'หน่วย', 'ราคาต่อหน่วย', 'ต้นทุนต่อหน่วย', 'รวม']
    ]);
    
    // 3. Get old orders
    const oldOrders = await getSheetData(CONFIG.SHEET_ID, 'คำสั่งซื้อ!A:J');
    
    if (oldOrders.length <= 1) {
      Logger.info('No orders to migrate');
      return;
    }
    
    // 4. Get stock data for cost lookup
    const stockData = await getSheetData(CONFIG.SHEET_ID, 'สต็อก!A:G');
    const stockMap = {};
    stockData.slice(1).forEach(row => {
      stockMap[row[0]] = {
        cost: parseFloat(row[1] || 0),
        price: parseFloat(row[2] || 0)
      };
    });
    
    // 5. Migrate each order
    const newOrderRows = [];
    const lineItemRows = [];
    
    oldOrders.slice(1).forEach(row => {
      const orderNo = row[0];
      const date = row[1];
      const customer = row[2];
      const item = row[3];
      const quantity = parseInt(row[4] || 0);
      const deliveryPerson = row[6] || '';
      const deliveryStatus = row[7] || 'รอดำเนินการ';
      const paymentStatus = row[8] || 'ยังไม่จ่าย';
      const total = parseFloat(row[9] || 0);
      
      // Create order header (one per order number)
      if (!newOrderRows.find(o => o[0] === orderNo)) {
        newOrderRows.push([
          orderNo,
          date,
          customer,
          deliveryPerson,
          deliveryStatus,
          paymentStatus,
          total,
          ''
        ]);
      }
      
      // Create line item
      const stock = stockMap[item] || { cost: 0, price: 0 };
      lineItemRows.push([
        orderNo,
        item,
        quantity,
        '', // unit - fill manually if needed
        stock.price,
        stock.cost,
        total
      ]);
    });
    
    // 6. Write migrated data
    if (newOrderRows.length > 0) {
      await appendSheetData(CONFIG.SHEET_ID, 'คำสั่งซื้อ_ใหม่!A:H', newOrderRows);
      Logger.success(`✅ Migrated ${newOrderRows.length} orders`);
    }
    
    if (lineItemRows.length > 0) {
      await appendSheetData(CONFIG.SHEET_ID, 'รายการสินค้า!A:G', lineItemRows);
      Logger.success(`✅ Migrated ${lineItemRows.length} line items`);
    }
    
    Logger.success('🎉 Migration complete!');
    Logger.info('\n⚠️  NEXT STEPS:');
    Logger.info('1. Verify data in "คำสั่งซื้อ_ใหม่" and "รายการสินค้า" sheets');
    Logger.info('2. Rename "คำสั่งซื้อ" → "คำสั่งซื้อ_เก่า"');
    Logger.info('3. Rename "คำสั่งซื้อ_ใหม่" → "คำสั่งซื้อ"');
    Logger.info('4. Deploy new code');
    
  } catch (error) {
    Logger.error('Migration failed', error);
    throw error;
  }
}

// Run migration
if (require.main === module) {
  const { initializeGoogleServices } = require('./googleServices');
  initializeGoogleServices();
  migrateToMultiItemOrders()
    .then(() => process.exit(0))
    .catch(err => {
      console.error(err);
      process.exit(1);
    });
}

module.exports = { migrateToMultiItemOrders };