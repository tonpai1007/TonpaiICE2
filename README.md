# 🤖 TonpaiICE2: AI-Powered LINE Order Management System

**TonpaiICE2** is an intelligent ERP system integrated into LINE, designed to automate order processing, inventory management, and customer credit tracking for local businesses.

Unlike standard chatbots, this system uses **Large Language Models (Llama 3 on Groq)** and **Voice Recognition (Whisper)** to understand natural language and voice commands, converting them into structured transactions in Google Sheets.

## 🚀 Key Features

### 🗣️ Voice-to-Order Engine
- **No Typing Needed:** Customers can send voice messages (e.g., "Jae Ann, 2 bags of ice, 3 packs of water").
- **AI Transcription:** Uses **Groq/Whisper** to transcribe Thai audio with high accuracy.
- **Natural Language Understanding:** Parses messy, informal orders into structured data (Item, Quantity, Unit).

### 🧠 Smart Order Learning
- **Customer Profiling:** Learns ordering patterns from history (e.g., "Jae Ann usually orders 5 bags").
- **Predictive Suggestions:** If a customer sends a vague order, the bot suggests their usual items.
- **Ambiguity Resolution:** Automatically asks for clarification if multiple products match (e.g., "Small water" vs "Large water").

### 💼 Business Logic & ERP
- **Dynamic Pricing:** Supports multi-tier pricing (VIP, Gold, Regular) and active promotions.
- **Inventory Management:** Real-time stock tracking with "Critical Low" alerts.
- **Credit System:** Tracks unpaid orders, partial payments, and generates debt reports (`CreditManager`).
- **Sales Analytics:** Generates daily, weekly, and monthly revenue reports.

### ⚡ Technical Highlights
- **Fast Inference:** Powered by **Groq API** for near-instant AI responses.
- **Zero-Database:** Uses **Google Sheets** as a backend database for easy access by non-technical staff.
- **Robust Error Handling:** Automatic retry logic for API calls and comprehensive logging.

---

## 🛠️ Tech Stack

- **Runtime:** Node.js (v18+)
- **Framework:** Express.js
- **AI Services:** - **LLM:** Llama-3.3-70b-versatile (via Groq)
  - **STT:** Whisper-large-v3 (via Groq)
- **Database:** Google Sheets API
- **Messaging:** LINE Messaging API

---

## ⚙️ Installation & Setup

### 1. Clone the Repository
```bash
git clone [https://github.com/yourusername/line-order-bot.git](https://github.com/yourusername/line-order-bot.git)
cd line-order-bot
2. Install Dependencies
Bash

npm install
3. Environment Configuration
Create a .env file in the root directory:

ข้อมูลโค้ด

# Server
PORT=3000

# LINE API
LINE_TOKEN=your_line_channel_access_token
LINE_SECRET=your_line_channel_secret

# AI Services
GROQ_API_KEY=your_groq_api_key

# Google Sheets
SHEET_ID=your_google_sheet_id
GOOGLE_APPLICATION_CREDENTIALS_BASE64=your_base64_encoded_json_key

# Admin Configuration
ADMIN_USER_IDS=userid1,userid2
4. Google Sheets Setup
Ensure your Google Sheet has the following tabs:

สต็อก (Stock): Columns A-G (Name, Price, Unit, Qty, etc.)

คำสั่งซื้อ (Orders): Columns A-I (OrderNo, Date, Customer, Item, Qty, Note, Delivery, Payment, Amount)

เครดิต (Credit): Columns A-G

ลูกค้า (Customers): For tier management

5. Run the Server
Bash

# Development (with nodemon)
npm run dev

# Production
npm start
📱 User Guide (Chat Commands)
For Customers / Staff
Order: "Jae Ann orders 2 bags of ice" or just send a Voice Message.

Short Format: "Coke 5, Water 2, Jae Ann"

Payment: "Pay" (Mark last order as paid) or "Pay #123"

Delivery: "Send P'Dang" (Update delivery person)

For Admins
Daily Summary: Type สรุป or summary to see today's sales.

Stock Check: Type มี [Item] (e.g., มี Coke) to check inventory.

Add Stock: เติม [Item] [Price] [Qty] (e.g., เติม Ice 60 50).

Credit Report: Type เครดิต to see who owes money.

Inbox: Type inbox to see raw message logs for debugging.

📂 Project Structure
src/
├── app.js                 # Entry point & Server config
├── messageHandlerService.js # Main logic router
├── aiServices.js          # Groq & Whisper integration
├── googleServices.js      # Google Sheets CRUD operations
├── businessLogic.js       # Pricing, Inventory, Credit logic
├── smartOrderLearning.js  # Customer pattern analysis
├── voiceProcessor.js      # Audio file handling
└── ...
📄 License
This project is licensed under the ISC License.

Author: Pongpun Teppanom
