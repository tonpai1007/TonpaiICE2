// constants.js - Static data and mappings



const REQUIRED_SHEETS = [
  // Order Header Sheet
  { 
    name: 'คำสั่งซื้อ', 
    headers: ['รหัสคำสั่ง', 'วันที่', 'ลูกค้า', 'ผู้ส่ง', 'สถานะการจัดส่ง', 'สถานะการชำระ', 'ยอดรวม', 'หมายเหตุ'] 
  },
  
  // Order Line Items Sheet (also used for stock data)
  { 
    name: 'รายการสินค้า', 
    headers: ['สินค้า', 'ต้นทุน', 'ราคาขาย', 'หน่วย', 'จำนวนคงเหลือ', 'หมวดหมู่', 'SKU'] 
  },
  
  // Dashboard Sheet
  { 
    name: 'Dashboard', 
    headers: ['วันที่', 'ลูกค้า', 'คำสั่งซื้อ', 'ต้นทุนรวม', 'ยอดขายรวม', 'กำไรรวม', 'สินค้าขายดี'] 
  },
  
  // Customer Sheet (already exists)
  {
    name: 'ลูกค้า',
    headers: ['ชื่อลูกค้า', 'เบอร์โทร', 'ที่อยู่', 'หมายเหตุ']
  },
  
  // Credit Sheet
  {
    name: 'เครดิต',
    headers: ['วันที่', 'ลูกค้า', 'รหัสคำสั่ง', 'ยอดเงิน', 'สถานะ', 'วันครบกำหนด', 'หมายเหตุ']
  }
];

module.exports = {
  
  REQUIRED_SHEETS
};
