// src/accessControl.js - FIXED: Proper initialization
const { CONFIG } = require('./config');
const { Logger } = require('./logger');

// ============================================================================
// ROLES AND PERMISSIONS
// ============================================================================

const ROLES = {
  ADMIN: 'admin',
  USER: 'user',
  GUEST: 'guest'
};

const PERMISSIONS = {
  PLACE_ORDER: 'place_order',
  VIEW_ORDERS: 'view_orders',
  CANCEL_ORDER: 'cancel_order',
  VIEW_STOCK: 'view_stock',
  ADD_STOCK: 'add_stock',
  UPDATE_STOCK: 'update_stock',
  UPDATE_PAYMENT: 'update_payment',
  VIEW_PAYMENT_HISTORY: 'view_payment_history',
  REFRESH_CACHE: 'refresh_cache',
  VIEW_DASHBOARD: 'view_dashboard',
  MANAGE_USERS: 'manage_users',
  UPDATE_DELIVERY: 'update_delivery',
  VIEW_DELIVERY_STATUS: 'view_delivery_status'
};

const ROLE_PERMISSIONS = {
  [ROLES.ADMIN]: [
    PERMISSIONS.PLACE_ORDER,
    PERMISSIONS.VIEW_ORDERS,
    PERMISSIONS.CANCEL_ORDER,
    PERMISSIONS.VIEW_STOCK,
    PERMISSIONS.ADD_STOCK,
    PERMISSIONS.UPDATE_STOCK,
    PERMISSIONS.UPDATE_PAYMENT,
    PERMISSIONS.VIEW_PAYMENT_HISTORY,
    PERMISSIONS.REFRESH_CACHE,
    PERMISSIONS.VIEW_DASHBOARD,
    PERMISSIONS.MANAGE_USERS,
    PERMISSIONS.UPDATE_DELIVERY,
    PERMISSIONS.VIEW_DELIVERY_STATUS
  ],
  [ROLES.USER]: [
    PERMISSIONS.PLACE_ORDER,
    PERMISSIONS.VIEW_DELIVERY_STATUS
  ],
  [ROLES.GUEST]: []
};

// ============================================================================
// USER STORAGE
// ============================================================================

class UserStore {
  constructor() {
    this.users = new Map();
    this.accessLog = [];
  }

  // ✅ FIXED: Delayed initialization
  initializeDefaultUsers() {
    // ✅ Check if CONFIG is available
    if (!CONFIG || !CONFIG.ADMIN_USER_IDS) {
      Logger.warn('⚠️ CONFIG not ready yet - will initialize admins later');
      return;
    }

    const adminIds = CONFIG.ADMIN_USER_IDS || [];
    
    if (adminIds.length === 0) {
      Logger.warn('⚠️ No admin users configured in ADMIN_USER_IDS');
      return;
    }
    
    adminIds.forEach(adminId => {
      if (adminId && adminId.trim()) {
        this.users.set(adminId, {
          userId: adminId,
          role: ROLES.ADMIN,
          name: 'Admin',
          createdAt: new Date().toISOString()
        });
        Logger.success(`✅ Admin user initialized: ${adminId.substring(0, 8)}...`);
      }
    });
  }

  addUser(userId, role = ROLES.USER, name = null) {
    if (this.users.has(userId)) {
      Logger.warn(`User ${userId.substring(0, 8)}... already exists`);
      return false;
    }

    this.users.set(userId, {
      userId,
      role,
      name: name || `User_${userId.substring(0, 8)}`,
      createdAt: new Date().toISOString()
    });

    Logger.success(`User added: ${userId.substring(0, 8)}... (${role})`);
    return true;
  }

  getUser(userId) {
    return this.users.get(userId);
  }

  getUserRole(userId) {
    const user = this.users.get(userId);
    return user ? user.role : ROLES.GUEST;
  }

  updateUserRole(userId, newRole) {
    const user = this.users.get(userId);
    if (!user) {
      Logger.warn(`User ${userId} not found`);
      return false;
    }

    user.role = newRole;
    Logger.success(`User ${userId.substring(0, 8)}... role updated to ${newRole}`);
    return true;
  }

  removeUser(userId) {
    if (!this.users.has(userId)) {
      return false;
    }

    this.users.delete(userId);
    Logger.success(`User ${userId.substring(0, 8)}... removed`);
    return true;
  }

  getAllUsers() {
    return Array.from(this.users.values());
  }

  logAccess(userId, action, granted, details = '') {
    const logEntry = {
      userId,
      action,
      granted,
      details,
      timestamp: new Date().toISOString()
    };

    this.accessLog.push(logEntry);

    if (this.accessLog.length > 1000) {
      this.accessLog.shift();
    }

    if (!granted) {
      Logger.warn(`Access denied: ${userId.substring(0, 8)}... tried ${action}`);
    }
  }

  getAccessLog(userId = null, limit = 100) {
    let logs = this.accessLog;
    
    if (userId) {
      logs = logs.filter(log => log.userId === userId);
    }

    return logs.slice(-limit);
  }
}

// ============================================================================
// ACCESS CONTROL CLASS
// ============================================================================

class AccessControl {
  constructor() {
    this.userStore = new UserStore();
    // ✅ FIXED: Initialize after a delay to ensure CONFIG is loaded
    setImmediate(() => {
      this.userStore.initializeDefaultUsers();
    });
  }

  hasPermission(userId, permission) {
    const role = this.userStore.getUserRole(userId);
    const permissions = ROLE_PERMISSIONS[role] || [];
    return permissions.includes(permission);
  }

  canPerformAction(userId, action) {
    if (!this.userStore.getUser(userId)) {
      this.userStore.addUser(userId, ROLES.USER);
    }

    return this.hasPermission(userId, action);
  }

  isAdmin(userId) {
    return this.userStore.getUserRole(userId) === ROLES.ADMIN;
  }

  isRegistered(userId) {
    return this.userStore.getUser(userId) !== undefined;
  }

  getUserRole(userId) {
    return this.userStore.getUserRole(userId);
  }

  addUser(userId, role = ROLES.USER, name = null) {
    return this.userStore.addUser(userId, role, name);
  }

  updateUserRole(userId, newRole) {
    return this.userStore.updateUserRole(userId, newRole);
  }

  removeUser(userId) {
    return this.userStore.removeUser(userId);
  }

  getAllUsers() {
    return this.userStore.getAllUsers();
  }

  logAccess(userId, action, granted, details = '') {
    this.userStore.logAccess(userId, action, granted, details);
  }

  getAccessLog(userId = null, limit = 100) {
    return this.userStore.getAccessLog(userId, limit);
  }

  getAccessDeniedMessage(action) {
    const messages = {
      [PERMISSIONS.PLACE_ORDER]: '🔒 ระบบปิดการรับคำสั่งซื้อชั่วคราว\nกรุณาติดต่อแอดมิน',
      [PERMISSIONS.VIEW_ORDERS]: '🔒 คุณไม่มีสิทธิ์ดูคำสั่งซื้อ\nติดต่อแอดมินเพื่อขอสิทธิ์',
      [PERMISSIONS.ADD_STOCK]: '🔒 เฉพาะแอดมินเท่านั้นที่เพิ่มสต็อกได้',
      [PERMISSIONS.UPDATE_STOCK]: '🔒 เฉพาะแอดมินเท่านั้นที่แก้ไขสต็อกได้',
      [PERMISSIONS.UPDATE_PAYMENT]: '🔒 เฉพาะแอดมินเท่านั้นที่อัปเดตการชำระเงินได้',
      [PERMISSIONS.REFRESH_CACHE]: '🔒 เฉพาะแอดมินเท่านั้นที่รีเฟรชระบบได้',
      [PERMISSIONS.VIEW_DASHBOARD]: '🔒 เฉพาะแอดมินเท่านั้นที่ดู Dashboard ได้',
      [PERMISSIONS.MANAGE_USERS]: '🔒 เฉพาะแอดมินเท่านั้นที่จัดการผู้ใช้ได้',
      [PERMISSIONS.UPDATE_DELIVERY]: '🔒 เฉพาะแอดมินเท่านั้นที่อัปเดตสถานะจัดส่งได้'
    };

    return messages[action] || '🔒 คุณไม่มีสิทธิ์เข้าถึงฟังก์ชันนี้';
  }

  getUserInfoText(userId) {
    const user = this.userStore.getUser(userId);
    
    if (!user) {
      return '❓ ไม่พบข้อมูลผู้ใช้';
    }

    const role = user.role;
    const permissions = ROLE_PERMISSIONS[role] || [];
    const roleNames = {
      [ROLES.ADMIN]: 'ผู้ดูแลระบบ',
      [ROLES.USER]: 'ผู้ใช้งาน',
      [ROLES.GUEST]: 'แขก'
    };

    let info = `👤 ข้อมูลผู้ใช้\n${'='.repeat(30)}\n\n`;
    info += `• ชื่อ: ${user.name}\n`;
    info += `• บทบาท: ${roleNames[role]}\n`;
    info += `• สิทธิ์: ${permissions.length} รายการ\n`;
    info += `• สมัครเมื่อ: ${user.createdAt}\n\n`;
    
    if (permissions.length > 0) {
      info += `🔑 สิทธิ์การใช้งาน:\n`;
      const permissionNames = {
        [PERMISSIONS.PLACE_ORDER]: '📦 สั่งซื้อสินค้า',
        [PERMISSIONS.VIEW_ORDERS]: '📋 ดูคำสั่งซื้อ',
        [PERMISSIONS.CANCEL_ORDER]: '❌ ยกเลิกคำสั่งซื้อ',
        [PERMISSIONS.VIEW_STOCK]: '📊 ดูสต็อกสินค้า',
        [PERMISSIONS.ADD_STOCK]: '➕ เพิ่มสต็อก',
        [PERMISSIONS.UPDATE_STOCK]: '✏️ แก้ไขสต็อก',
        [PERMISSIONS.UPDATE_PAYMENT]: '💰 อัปเดตการชำระเงิน',
        [PERMISSIONS.VIEW_PAYMENT_HISTORY]: '📖 ดูประวัติการชำระ',
        [PERMISSIONS.REFRESH_CACHE]: '🔄 รีเฟรชระบบ',
        [PERMISSIONS.VIEW_DASHBOARD]: '📊 ดู Dashboard',
        [PERMISSIONS.MANAGE_USERS]: '👥 จัดการผู้ใช้',
        [PERMISSIONS.UPDATE_DELIVERY]: '🚚 อัปเดตการจัดส่ง',
        [PERMISSIONS.VIEW_DELIVERY_STATUS]: '📦 ดูสถานะจัดส่ง'
      };

      permissions.slice(0, 10).forEach(perm => {
        info += `  ${permissionNames[perm] || perm}\n`;
      });

      if (permissions.length > 10) {
        info += `  ... และอีก ${permissions.length - 10} รายการ\n`;
      }
    }

    return info;
  }

  getSystemStats() {
    const users = this.userStore.getAllUsers();
    const adminCount = users.filter(u => u.role === ROLES.ADMIN).length;
    const userCount = users.filter(u => u.role === ROLES.USER).length;
    const recentLogs = this.userStore.getAccessLog(null, 10);

    let stats = `📊 สถิติระบบ\n${'='.repeat(30)}\n\n`;
    stats += `👥 ผู้ใช้ทั้งหมด: ${users.length}\n`;
    stats += `  • แอดมิน: ${adminCount}\n`;
    stats += `  • ผู้ใช้: ${userCount}\n\n`;
    stats += `📝 กิจกรรมล่าสุด (10 รายการ):\n`;
    
    recentLogs.reverse().forEach(log => {
      const icon = log.granted ? '✅' : '❌';
      const time = new Date(log.timestamp).toLocaleTimeString('th-TH');
      stats += `${icon} ${time} - ${log.action}\n`;
    });

    return stats;
  }
}

// ============================================================================
// SINGLETON INSTANCE
// ============================================================================

const accessControl = new AccessControl();

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  AccessControl: accessControl,
  ROLES,
  PERMISSIONS,
  ROLE_PERMISSIONS
};