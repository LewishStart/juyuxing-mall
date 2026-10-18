/**
 * 林元元 中医生活 — Web 管理后台
 * Vue 3 + 微信云开发 JS SDK
 */

const { createApp, ref, reactive, computed, onMounted, onBeforeUnmount, nextTick, watch } = Vue;

// ===== 云开发初始化 =====
const ENV_ID = 'cloud1-d4gx1jxk675274501';
const cloudbaseSdk = window.cloudbase;
if (!cloudbaseSdk) throw new Error('CloudBase Web SDK 加载失败');
const tcbApp = cloudbaseSdk.init({ env: ENV_ID });
const auth = tcbApp.auth({ persistence: 'local' });

function readStoredJson(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) : fallback;
  } catch (e) {
    localStorage.removeItem(key);
    return fallback;
  }
}

// ===== API 封装 =====
async function callAdmin(action, data = {}) {
  const token = localStorage.getItem('adminToken') || '';
  try {
    const res = await tcbApp.callFunction({
      name: 'admin',
      data: { action, adminToken: token, ...data }
    });
    const catalogActions = ['productList', 'orderList', 'orderDetail', 'refundList'];
    return window.MallBrand && catalogActions.includes(action)
      ? window.MallBrand.normalizeBrandDisplay(res.result) : res.result;
  } catch (e) {
    console.error(`[callAdmin] ${action} failed:`, e);
    const message = String((e && e.message) || '');
    if (message.includes('PERMISSION_DENIED')) {
      return {
        success: false,
        error: '后台云函数权限未允许自定义登录身份调用，请检查 admin 安全规则'
      };
    }
    if (message.includes("reading 'scope'") || message.includes('evaluating \'t.scope\'')) {
      return {
        success: false,
        error: 'CloudBase 匿名登录未成功，请检查匿名登录和云函数权限配置'
      };
    }
    return { success: false, error: message || '网络请求失败' };
  }
}

async function callAdminQrAuth(action, data = {}) {
  try {
    const res = await tcbApp.callFunction({
      name: 'adminQrAuth',
      data: { action, ...data }
    });
    return res.result;
  } catch (e) {
    console.error(`[callAdminQrAuth] ${action} failed:`, e);
    const message = String((e && e.message) || '');
    if (message.includes('PERMISSION_DENIED')) {
      return { success: false, error: '扫码登录云函数权限尚未开放，请检查 adminQrAuth 安全规则' };
    }
    return { success: false, error: message || '扫码登录服务暂不可用' };
  }
}

async function ensureAnonymousLogin() {
  try {
    let state = await auth.getLoginState();
    if (!state) {
      await auth.signInAnonymously();
      state = await auth.getLoginState();
    }
    if (!state) {
      throw new Error('ANONYMOUS_LOGIN_NOT_ESTABLISHED');
    }
    return { success: true };
  } catch (e) {
    console.error('匿名登录未启用:', e);
    return {
      success: false,
      error: '后台连接尚未启用：请先在 CloudBase 控制台开启“匿名登录”'
    };
  }
}

// ===== Vue App =====
const App = {
  setup() {
    // ----- 全局状态 -----
    const isLoggedIn = ref(!!localStorage.getItem('adminToken'));
    const loading = ref(false);
    const loginError = ref('');
    const qrLogin = reactive({
      loading: false,
      authenticating: false,
      qrDataUrl: '',
      publicId: '',
      pollSecret: '',
      expiresAt: null,
      secondsLeft: 0,
      status: 'idle'
    });
    let qrCountdownTimer = null;
    let qrPollTimer = null;
    let qrPollInFlight = false;
    const currentPage = ref('dashboard');
    const toast = reactive({ show: false, msg: '', type: 'info', timer: null });

    // ----- 导航 -----
    const currentAccount = ref(readStoredJson('adminAccount', null));
    const allPages = [
      { id: 'dashboard', name: '数据看板', icon: '📊' },
      { id: 'orders', name: '订单管理', icon: '📦' },
      { id: 'refunds', name: '退款管理', icon: '🔄' },
      { id: 'products', name: '商品管理', icon: '🏷️' },
      { id: 'inventory', name: '库存管理', icon: '🧮' },
      { id: 'agents', name: '分销员管理', icon: '👥' },
      { id: 'invites', name: '分销邀请', icon: '🔗' },
      { id: 'withdrawals', name: '提现审批', icon: '💰' },
      { id: 'finance', name: '经营收支', icon: '📈' },
      { id: 'messages', name: '客服消息', icon: '💬' },
      { id: 'accounts', name: '后台账号', icon: '🔐' },
      { id: 'settings', name: '系统设置', icon: '⚙️' }
    ];
    const rolePages = {
      owner: allPages.map(page => page.id),
      operations: ['dashboard', 'orders', 'products', 'inventory', 'agents', 'invites', 'messages', 'settings'],
      finance: ['dashboard', 'orders', 'refunds', 'withdrawals', 'finance', 'settings']
    };
    const pages = computed(() => allPages.filter(page => {
      const role = currentAccount.value && currentAccount.value.role;
      return !role || (rolePages[role] || []).includes(page.id);
    }));

    // ----- Dashboard -----
    const cachedDashboard = readStoredJson('adminDashboardCache', {});
    const stats = ref(cachedDashboard.stats || {});
    const recentOrders = ref(cachedDashboard.recentOrders || []);
    const finance = ref(null);
    const financeError = ref('');
    const financeLoading = ref(false);
    let financeRequestId = 0;
    const inventory = ref([]);
    const invites = ref([]);
    const inviteForm = reactive({ name: '', phone: '' });
    const accounts = ref([]);
    const accountForm = reactive({ username: '', displayName: '', role: 'operations', password: '' });

    // ----- Orders -----
    const orders = ref([]);
    const orderFilter = ref('');
    const orderFilters = [
      { label: '全部', value: '' },
      { label: '待付款', value: 'pending' },
      { label: '待发货', value: 'paid' },
      { label: '已发货', value: 'shipped' },
      { label: '已收货', value: 'received' },
      { label: '退款中', value: 'refunding' },
      { label: '已退款', value: 'refunded' },
      { label: '已关闭', value: 'closed' }
    ];
    const shipModal = reactive({ show: false, orderId: '', orderNo: '', company: '', trackingNo: '' });
    const orderDetailModal = reactive({ show: false, data: null });

    // ----- Products -----
    const products = ref([]);
    const productModal = reactive({
      show: false, isEdit: false, data: {}, imagesText: ''
    });

    // ----- Messages -----
    const messageUsers = ref([]);
    const currentChatUser = ref(null);
    const currentChatUserName = ref('');
    const chatMessages = ref([]);
    const replyText = ref('');
    const chatBox = ref(null);

    // ----- Settings -----
    const settings = ref({});
    const fullReduction = reactive({ enabled: false, rules: [] });
    const pwdForm = reactive({ oldPassword: '', newPassword: '' });
    const newOpenId = ref('');
    const migration = reactive({ preview: null, previewing: false, running: false });
    const transactionCleanup = reactive({
      preview: null,
      previewing: false,
      running: false,
      confirmText: ''
    });

    // ----- Agents -----
    const agents = ref([]);
    const agentFilter = ref('pending');
    const agentFilters = [
      { label: '待审核', value: 'pending' },
      { label: '已通过', value: 'active' },
      { label: '已拒绝', value: 'rejected' },
      { label: '全部', value: 'all' }
    ];

    // ----- Withdrawals -----
    const withdrawals = ref([]);
    const withdrawalFilter = ref('pending');
    const withdrawalFilters = [
      { label: '待处理', value: 'pending' },
      { label: '待打款', value: 'pending_pay' },
      { label: '转账中', value: 'transferring' },
      { label: '已到账', value: 'success' },
      { label: '已拒绝', value: 'rejected' },
      { label: '全部', value: 'all' }
    ];
    const withdrawalModal = reactive({ show: false, data: null, approve: true, remark: '' });

    // ----- Refunds -----
    const refunds = ref([]);
    const refundFilter = ref('pending');
    const refundOperatorQr = reactive({ show: false, loading: false, image: '', error: '' });
    const refundFilters = [
      { label: '待处理', value: 'pending' },
      { label: '已退款', value: 'approved' },
      { label: '退款库存待恢复', value: 'inventory_pending' },
      { label: '已拒绝', value: 'rejected' },
      { label: '全部', value: 'all' }
    ];
    const refundModal = reactive({ show: false, data: null, approve: true, adminNote: '', returnReceived: false, restock: false, readOnly: false });
    const refundDiagnostics = reactive({});
    const queryingRefundId = ref('');
    const processingAction = ref(false);

    // ===== 工具函数 =====
    function showToast(msg, type = 'success', duration = 2500) {
      if (toast.timer) clearTimeout(toast.timer);
      toast.msg = msg;
      toast.type = type;
      toast.show = true;
      toast.timer = setTimeout(() => { toast.show = false; }, duration);
    }

    function formatPrice(cents) {
      if (!cents) return '0.00';
      return (cents / 100).toFixed(2);
    }

    function formatTime(time) {
      if (!time) return '-';
      const d = new Date(time);
      const pad = n => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }

    function statusText(status) {
      const map = {
        pending: '待付款', paid: '待发货', shipped: '已发货', received: '已收货',
        refunding: '退款中', refunded: '已退款', cancelled: '已取消', closed: '已关闭'
      };
      return map[status] || status;
    }

    function orderItemsText(order) {
      if (!order.items || !order.items.length) return '-';
      return order.items.map(i => `${i.name} x${i.quantity}`).join(', ');
    }

    // ===== 微信扫码登录 =====
    function stopQrTimers() {
      if (qrCountdownTimer) clearInterval(qrCountdownTimer);
      if (qrPollTimer) clearInterval(qrPollTimer);
      qrCountdownTimer = null;
      qrPollTimer = null;
      qrPollInFlight = false;
    }

    function updateQrCountdown() {
      if (!qrLogin.expiresAt) {
        qrLogin.secondsLeft = 0;
        return;
      }
      qrLogin.secondsLeft = Math.max(0, Math.ceil((new Date(qrLogin.expiresAt).getTime() - Date.now()) / 1000));
      if (qrLogin.secondsLeft === 0 && qrLogin.status === 'pending') {
        qrLogin.status = 'expired';
        loginError.value = '二维码已过期，请刷新后重试';
        stopQrTimers();
      }
    }

    async function finishQrLogin(result) {
      qrLogin.authenticating = true;
      qrLogin.status = 'authenticating';
      stopQrTimers();
      try {
        let transportReady = false;
        if (result.cloudbaseTicket) {
          try {
            await auth.signOut().catch(() => {});
            await auth.setCustomSignFunc(() => Promise.resolve(result.cloudbaseTicket));
            await auth.signInWithCustomTicket();
            transportReady = !!(await auth.getLoginState());
          } catch (customError) {
            console.warn('自定义登录不可用，切换匿名传输身份:', customError);
          }
        }
        if (!transportReady) {
          await auth.signOut().catch(() => {});
          const anonymous = await ensureAnonymousLogin();
          if (!anonymous.success) throw new Error('ANONYMOUS_LOGIN_NOT_ESTABLISHED');
        }
        localStorage.setItem('adminToken', result.adminToken);
        localStorage.setItem('adminAccount', JSON.stringify(result.account || {}));
        currentAccount.value = result.account || {};
        isLoggedIn.value = true;
        loginError.value = '';
        qrLogin.status = 'authenticated';
        showToast('微信扫码登录成功');
        await loadDashboard();
      } catch (err) {
        console.error('自定义登录失败:', err);
        qrLogin.status = 'error';
        loginError.value = '微信身份登录失败，请刷新二维码后重试';
      } finally {
        qrLogin.authenticating = false;
      }
    }

    async function pollQrLogin() {
      if (qrPollInFlight || document.hidden || qrLogin.status !== 'pending') return;
      qrPollInFlight = true;
      try {
        const result = await callAdminQrAuth('pollQrLogin', {
          publicId: qrLogin.publicId,
          pollSecret: qrLogin.pollSecret
        });
        if (result && result.success && result.status === 'authenticated') {
          await finishQrLogin(result);
        } else if (result && ['expired', 'consumed'].includes(result.status)) {
          qrLogin.status = result.status;
          loginError.value = result.error || '二维码不可用，请刷新后重试';
          stopQrTimers();
        }
      } finally {
        qrPollInFlight = false;
      }
    }

    function startQrTimers() {
      stopQrTimers();
      updateQrCountdown();
      qrCountdownTimer = setInterval(updateQrCountdown, 1000);
      qrPollTimer = setInterval(pollQrLogin, 2000);
    }

    async function startQrLogin() {
      if (qrLogin.loading || isLoggedIn.value) return;
      stopQrTimers();
      Object.assign(qrLogin, {
        loading: true,
        authenticating: false,
        qrDataUrl: '',
        publicId: '',
        pollSecret: '',
        expiresAt: null,
        secondsLeft: 0,
        status: 'loading'
      });
      loginError.value = '';
      const authResult = await ensureAnonymousLogin();
      if (!authResult.success) {
        qrLogin.loading = false;
        qrLogin.status = 'error';
        loginError.value = authResult.error;
        return;
      }
      const result = await callAdminQrAuth('createQrLogin');
      qrLogin.loading = false;
      if (!result || !result.success) {
        qrLogin.status = 'error';
        loginError.value = (result && result.error) || '二维码生成失败';
        return;
      }
      Object.assign(qrLogin, {
        qrDataUrl: result.qrDataUrl || '',
        publicId: result.publicId,
        pollSecret: result.pollSecret,
        expiresAt: result.expiresAt,
        status: 'pending'
      });
      if (!qrLogin.qrDataUrl) {
        qrLogin.status = 'error';
        loginError.value = '小程序码生成失败，请确认 adminQrAuth 云函数具备微信开放接口权限';
        return;
      }
      startQrTimers();
    }

    function handleVisibilityChange() {
      if (document.hidden) {
        if (qrPollTimer) clearInterval(qrPollTimer);
        qrPollTimer = null;
      } else if (!isLoggedIn.value && qrLogin.status === 'pending' && !qrPollTimer) {
        qrPollTimer = setInterval(pollQrLogin, 2000);
        pollQrLogin();
      }
    }

    async function logout() {
      Object.keys(refundDiagnostics).forEach(id => { delete refundDiagnostics[id]; });
      refundModal.show = false;
      await callAdmin('logout');
      await auth.signOut().catch(() => {});
      localStorage.removeItem('adminToken');
      localStorage.removeItem('adminAccount');
      currentAccount.value = null;
      isLoggedIn.value = false;
      currentPage.value = 'dashboard';
      startQrLogin();
    }

    // ===== 页面切换 =====
    function switchPage(pageId) {
      currentPage.value = pageId;
      switch (pageId) {
        case 'dashboard': loadDashboard(); break;
        case 'orders': loadOrders(); break;
        case 'refunds': loadRefunds(); break;
        case 'products': loadProducts(); break;
        case 'inventory': loadInventory(); break;
        case 'agents': loadAgents(); break;
        case 'invites': loadInvites(); break;
        case 'withdrawals': loadWithdrawals(); break;
        case 'finance': loadFinance(); break;
        case 'messages': loadMessageUsers(); break;
        case 'accounts': loadAccounts(); break;
        case 'settings': loadSettings(); break;
      }
    }

    // ===== Dashboard =====
    async function loadDashboard() {
      const res = await callAdmin('dashboard');
      if (!res.success) return false;

      stats.value = res.stats || {};
      if (res.account) {
        currentAccount.value = res.account;
        localStorage.setItem('adminAccount', JSON.stringify(res.account));
      }

      // 新版 dashboard 一次返回最近订单；兼容尚未重部署的旧云函数。
      if (Array.isArray(res.recentOrders)) {
        recentOrders.value = res.recentOrders;
      } else {
        const orderRes = await callAdmin('orderList', { pageSize: 10 });
        if (orderRes.success) recentOrders.value = orderRes.data;
      }
      localStorage.setItem('adminDashboardCache', JSON.stringify({
        stats: stats.value,
        recentOrders: recentOrders.value,
        cachedAt: Date.now()
      }));
      return true;
    }

    // ===== Orders =====
    async function loadOrders() {
      const res = await callAdmin('orderList', { status: orderFilter.value, pageSize: 100 });
      if (res.success) {
        orders.value = res.data;
      }
    }

    function switchOrderFilter(val) {
      orderFilter.value = val;
      loadOrders();
    }

    function openShipModal(order) {
      if (order.paymentResolutionRequired === true) {
        showToast('库存已释放后确认收款，请按原订单申请仅退款', 'error');
        return;
      }
      shipModal.orderId = order._id;
      shipModal.orderNo = order.orderNo;
      shipModal.company = '';
      shipModal.trackingNo = '';
      shipModal.show = true;
    }

    async function confirmShip() {
      const res = await callAdmin('shipOrder', {
        orderId: shipModal.orderId,
        company: shipModal.company,
        trackingNo: shipModal.trackingNo
      });
      if (res.success) {
        showToast('发货成功');
        shipModal.show = false;
        loadOrders();
        loadDashboard();
      } else {
        showToast(res.error || '发货失败', 'error');
      }
    }

    function formatOrderAddress(address) {
      if (!address) return '';
      const region = Array.isArray(address.region) && address.region.length
        ? address.region : [address.province, address.city, address.district];
      return region.filter(Boolean).join('') + (address.detail || '');
    }

    function viewOrder(order) {
      orderDetailModal.data = order;
      orderDetailModal.show = true;
    }

    // ===== Products =====
    async function loadProducts() {
      const res = await callAdmin('productList');
      if (res.success) {
        products.value = res.data;
      }
    }

    function yuanToFen(value, allowZero = false) {
      const text = String(value === undefined || value === null ? '' : value).trim();
      if (!/^(0|[1-9]\d*)(\.\d{1,2})?$/.test(text)) throw new Error('金额请输入最多两位小数的元');
      const [whole, fraction = ''] = text.split('.');
      const fen = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
      if (!Number.isSafeInteger(fen) || fen < (allowZero ? 0 : 1)) throw new Error('金额超出范围');
      return fen;
    }

    function openProductModal(product) {
      if (product) {
        productModal.isEdit = true;
        productModal.data = { ...product, price: (product.price / 100).toFixed(2),
          originalPrice: ((product.originalPrice || 0) / 100).toFixed(2) };
        productModal.imagesText = (product.images || []).join('\n');
      } else {
        productModal.isEdit = false;
        productModal.data = { name: '', subtitle: '', price: '', originalPrice: '',
          stock: '', category: '', description: '', status: 'on' };
        productModal.imagesText = '';
      }
      productModal.show = true;
    }

    async function saveProduct() {
      const d = productModal.data;
      let price, originalPrice;
      try {
        price = yuanToFen(d.price);
        originalPrice = d.originalPrice === '' || d.originalPrice === undefined ? 0 : yuanToFen(d.originalPrice, true);
      } catch (error) { showToast(error.message, 'error'); return; }
      const images = productModal.imagesText.split('\n').map(s => s.trim()).filter(Boolean);
      const payload = { name: d.name, subtitle: d.subtitle, price, originalPrice,
        category: d.category, description: d.description, images, status: d.status || 'on' };
      // Existing multi-SKU inventory is edited per SKU; changing catalog price never rewrites SKU prices.
      if (!productModal.isEdit || !(d.specs && d.specs.length > 1)) payload.stock = d.stock;
      const res = productModal.isEdit ? await callAdmin('updateProduct', { id: d._id, ...payload })
        : await callAdmin('createProduct', payload);
      if (res.success) {
        showToast(productModal.isEdit ? '商品已更新' : '商品已创建');
        productModal.show = false;
        loadProducts();
      } else showToast(res.error || '操作失败', 'error');
    }

    async function toggleProduct(product, status) {
      const res = await callAdmin('toggleProductStatus', { id: product._id, status });
      if (res.success) {
        showToast(res.message);
        loadProducts();
      } else {
        showToast(res.error || '操作失败', 'error');
      }
    }

    async function deleteProduct(product) {
      if (!confirm(`确定删除商品「${product.name}」吗？`)) return;
      const res = await callAdmin('deleteProduct', { id: product._id });
      if (res.success) {
        showToast('商品已删除');
        loadProducts();
      } else {
        showToast(res.error || '删除失败', 'error');
      }
    }

    // ===== 库存 =====
    async function loadInventory() {
      const res = await callAdmin('inventoryList');
      if (res.success) inventory.value = res.data || [];
    }

    async function adjustInventory(product) {
      const specs = product.specs || [];
      let spec = specs.length === 1 ? specs[0].name : '';
      if (specs.length > 1) {
        spec = prompt('请输入要调整的规格名称\n' + specs.map(item => item.name).join(' / '), '');
        if (spec === null) return;
        if (!specs.some(item => item.name === spec)) { showToast('请选择有效规格', 'error'); return; }
      }
      const input = prompt(`调整「${product.name}」${spec || ''}库存（正数入库，负数出库）`, '0');
      if (input === null) return;
      const quantity = Number(input);
      if (!Number.isSafeInteger(quantity) || quantity === 0) { showToast('请输入非零整数', 'error'); return; }
      const reason = String(prompt('请输入库存调整原因', '人工盘点') || '').trim();
      if (!reason) return;
      const actor = currentAccount.value || {};
      const logicalKey = JSON.stringify([actor.accountId || actor.username || 'session', product._id, spec, quantity, reason]);
      let pending;
      try {
        pending = readStoredJson('inventoryPendingRequests', {});
        if (!pending[logicalKey]) {
          pending[logicalKey] = 'inventory_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 14);
          localStorage.setItem('inventoryPendingRequests', JSON.stringify(pending));
        }
      } catch (error) { showToast('无法保存操作凭据，未提交库存调整', 'error'); return; }
      const res = await callAdmin('adjustInventory', { productId: product._id, spec, quantity, reason, requestId: pending[logicalKey] });
      if (res.success) {
        const latestPending = readStoredJson('inventoryPendingRequests', {});
        if (latestPending[logicalKey] === pending[logicalKey]) delete latestPending[logicalKey];
        localStorage.setItem('inventoryPendingRequests', JSON.stringify(latestPending));
        showToast('库存已调整'); loadInventory();
      } else showToast(res.error || '调整失败，可使用相同参数重试', 'error');
    }

    // ===== 经营收支 =====
    async function loadFinance() {
      const requestId = ++financeRequestId;
      financeLoading.value = true;
      financeError.value = '';
      finance.value = null;
      try {
        const res = await callAdmin('financeOverview');
        if (requestId !== financeRequestId) return;
        if (!res || !res.success || !res.data) throw new Error((res && res.error) || '财务数据不可用');
        finance.value = res.data;
      } catch (error) {
        if (requestId !== financeRequestId) return;
        finance.value = null;
        financeError.value = error.message || '财务数据不可用';
      } finally {
        if (requestId === financeRequestId) financeLoading.value = false;
      }
    }

    // ===== 分销邀请 =====
    const inviteQrModal = reactive({ visible: false, loading: false, qrDataUrl: '', error: '', invite: null });

    function closeInviteQr() {
      inviteQrModal.visible = false;
    }

    function extractInviteToken(invitePath) {
      const match = String(invitePath || '').match(/[?&]token=([^&]+)/);
      return match ? decodeURIComponent(match[1]) : '';
    }

    async function openInviteQr(invite) {
      inviteQrModal.visible = true;
      inviteQrModal.loading = true;
      inviteQrModal.error = '';
      inviteQrModal.qrDataUrl = '';
      inviteQrModal.invite = invite || null;
      if (invite && invite.qrDataUrl) {
        inviteQrModal.qrDataUrl = invite.qrDataUrl;
        inviteQrModal.loading = false;
        return;
      }
      const token = invite ? extractInviteToken(invite.invitePath || '') : '';
      if (!token) {
        inviteQrModal.loading = false;
        inviteQrModal.error = '该邀请缺少令牌信息，仅创建时可生成小程序码';
        return;
      }
      const res = await callAdminQrAuth('inviteQr', { token });
      inviteQrModal.loading = false;
      if (res.success && res.qrDataUrl) {
        inviteQrModal.qrDataUrl = res.qrDataUrl;
        if (invite) invite.qrDataUrl = res.qrDataUrl;
      } else {
        inviteQrModal.error = res.error || '小程序码生成失败，请稍后重试';
      }
    }

    async function loadInvites() {
      const res = await callAdmin('inviteList');
      if (res.success) invites.value = res.data || [];
    }

    async function createInvite() {
      const res = await callAdmin('createInvite', { name: inviteForm.name, phone: inviteForm.phone });
      if (!res.success) { showToast(res.error || '邀请生成失败', 'error'); return; }
      inviteForm.name = '';
      inviteForm.phone = '';
      await navigator.clipboard.writeText(res.invitePath).catch(() => {});
      showToast('邀请已生成');
      await loadInvites();
      // 立即生成小程序码并弹窗展示，供分销员扫码激活
      const token = extractInviteToken(res.invitePath);
      if (token) await openInviteQr({ token, invitePath: res.invitePath });
      else showToast('邀请路径已复制', 'error');
    }

    async function revokeInvite(invite) {
      if (!confirm('确定撤销这条邀请？')) return;
      const res = await callAdmin('revokeInvite', { id: invite._id });
      if (res.success) { showToast('邀请已撤销'); loadInvites(); }
      else showToast(res.error || '撤销失败', 'error');
    }

    // ===== 后台账号 =====
    async function loadAccounts() {
      const res = await callAdmin('accountList');
      if (res.success) accounts.value = res.data || [];
    }

    async function createAccount() {
      const res = await callAdmin('createAccount', { ...accountForm });
      if (!res.success) { showToast(res.error || '账号创建失败', 'error'); return; }
      Object.assign(accountForm, { username: '', displayName: '', role: 'operations', password: '' });
      showToast('后台账号已创建');
      loadAccounts();
    }

    async function toggleAccount(account) {
      const status = account.status === 'active' ? 'disabled' : 'active';
      const res = await callAdmin('updateAccount', { id: account._id, status });
      if (res.success) loadAccounts();
      else showToast(res.error || '账号更新失败', 'error');
    }

    // ===== Messages =====
    async function loadMessageUsers() {
      const res = await callAdmin('messageUsers');
      if (res.success) {
        messageUsers.value = res.data;
      }
    }

    async function selectChatUser(user) {
      currentChatUser.value = user.userOpenId;
      currentChatUserName.value = user.nickName;
      const res = await callAdmin('messageHistory', { userOpenId: user.userOpenId });
      if (res.success) {
        chatMessages.value = res.data;
        nextTick(() => {
          if (chatBox.value) chatBox.value.scrollTop = chatBox.value.scrollHeight;
        });
      }
    }

    async function sendReply() {
      if (!replyText.value.trim()) return;
      const res = await callAdmin('adminReply', {
        userOpenId: currentChatUser.value,
        content: replyText.value.trim()
      });
      if (res.success) {
        chatMessages.value.push({
          content: replyText.value.trim(),
          isAdmin: true,
          createTime: new Date()
        });
        replyText.value = '';
        nextTick(() => {
          if (chatBox.value) chatBox.value.scrollTop = chatBox.value.scrollHeight;
        });
        loadMessageUsers();
      } else {
        showToast('发送失败', 'error');
      }
    }

    // ===== Settings =====
    async function loadSettings() {
      const res = await callAdmin('getSettings');
      if (res.success) {
        settings.value = res.settings;
        const fr = (res.settings && res.settings.fullReduction) || {};
        fullReduction.enabled = fr.enabled === true;
        fullReduction.rules = (Array.isArray(fr.rules) ? fr.rules : []).map(rule => ({
          thresholdYuan: (Number(rule.threshold) || 0) / 100,
          discountYuan: (Number(rule.discount) || 0) / 100
        }));
      }
    }

    async function changePassword() {
      const res = await callAdmin('changePassword', {
        oldPassword: pwdForm.oldPassword,
        newPassword: pwdForm.newPassword
      });
      if (res.success) {
        showToast('密码已更新');
        pwdForm.oldPassword = '';
        pwdForm.newPassword = '';
        loadSettings();
      } else {
        showToast(res.error || '修改失败', 'error');
      }
    }

    async function addAdminOpenId() {
      if (!newOpenId.value.trim()) return;
      const res = await callAdmin('addAdminOpenId', { openId: newOpenId.value.trim() });
      if (res.success) {
        showToast('已添加管理员');
        newOpenId.value = '';
        loadSettings();
      } else {
        showToast(res.error || '添加失败', 'error');
      }
    }

    async function removeAdminOpenId(openId) {
      if (!confirm('确定移除该管理员？')) return;
      const res = await callAdmin('removeAdminOpenId', { openId });
      if (res.success) {
        showToast('已移除');
        loadSettings();
      } else {
        showToast(res.error || '移除失败', 'error');
      }
    }

    // ===== 满减规则管理 =====
    function addFullReductionRule() {
      if (fullReduction.rules.length >= 5) {
        showToast('最多 5 条规则', 'error');
        return;
      }
      fullReduction.rules.push({ thresholdYuan: null, discountYuan: null });
    }

    function removeFullReductionRule(idx) {
      fullReduction.rules.splice(idx, 1);
    }

    async function saveFullReduction() {
      const rules = fullReduction.rules.map(rule => ({
        threshold: Math.round((Number(rule.thresholdYuan) || 0) * 100),
        discount: Math.round((Number(rule.discountYuan) || 0) * 100)
      }));
      if (fullReduction.enabled) {
        const valid = rules.filter(r => r.threshold > 0 && r.discount > 0 && r.discount < r.threshold);
        if (valid.length !== rules.length || valid.length === 0) {
          showToast('每条规则需满足：门槛与优惠均为正数，且优惠小于门槛', 'error');
          return;
        }
      }
      const res = await callAdmin('setFullReduction', {
        fullReduction: { enabled: fullReduction.enabled, rules }
      });
      if (res.success) {
        showToast(res.message || '满减设置已保存');
        loadSettings();
      } else {
        showToast(res.error || '保存失败', 'error');
      }
    }

    // ===== 佣金比例保存 =====
    async function saveCommissionRate() {
      const rate = settings.value.commissionRate;
      if (rate === undefined || rate === null || isNaN(rate)) {
        showToast('请输入有效的佣金比例', 'error');
        return;
      }
      if (rate < 0 || rate > 1) {
        showToast('佣金比例必须在 0~1 之间', 'error');
        return;
      }
      const res = await callAdmin('setCommissionRate', { commissionRate: rate });
      if (res.success) {
        showToast(res.message || '佣金比例已保存');
      } else {
        showToast(res.error || '保存失败', 'error');
      }
    }

    // ===== 微信支付 API 直连凭证 =====
    const payApiForm = reactive({ apiV2Key: '', certBase64: '', certFileName: '', certSizeKB: 0, certPassword: '' });
    const savingPayApi = ref(false);

    function onPayCertFileChange(ev) {
      const file = ev.target.files && ev.target.files[0];
      if (!file) {
        payApiForm.certBase64 = '';
        payApiForm.certFileName = '';
        payApiForm.certSizeKB = 0;
        return;
      }
      if (!/\.p12$/i.test(file.name)) {
        showToast('请选择 .p12 证书文件（apiclient_cert.p12）', 'error');
        ev.target.value = '';
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        // ArrayBuffer → base64
        const buf = new Uint8Array(reader.result);
        let binary = '';
        for (let i = 0; i < buf.length; i++) binary += String.fromCharCode(buf[i]);
        payApiForm.certBase64 = btoa(binary);
        payApiForm.certFileName = file.name;
        payApiForm.certSizeKB = Math.round(buf.length / 1024 * 10) / 10;
      };
      reader.onerror = () => showToast('读取证书文件失败，请重试', 'error');
      reader.readAsArrayBuffer(file);
    }

    async function savePayApiConfig() {
      if (!payApiForm.apiV2Key || !payApiForm.certBase64) {
        showToast('请填写 APIv2 密钥并选择证书文件', 'error');
        return;
      }
      savingPayApi.value = true;
      try {
        const res = await callAdmin('savePayApiConfig', {
          apiV2Key: payApiForm.apiV2Key,
          apiCertP12: payApiForm.certBase64,
          apiCertPassword: payApiForm.certPassword || ''
        });
        if (res.success) {
          showToast(res.message || '直连凭证已保存');
          payApiForm.apiV2Key = '';
          payApiForm.certBase64 = '';
          payApiForm.certFileName = '';
          payApiForm.certSizeKB = 0;
          payApiForm.certPassword = '';
          loadSettings();
        } else {
          showToast(res.error || '保存失败', 'error');
        }
      } finally {
        savingPayApi.value = false;
      }
    }

    async function clearPayApiConfig() {
      savingPayApi.value = true;
      try {
        const res = await callAdmin('clearPayApiConfig', {});
        if (res.success) {
          showToast(res.message || '已清除直连凭证');
          loadSettings();
        } else {
          showToast(res.error || '清除失败', 'error');
        }
      } finally {
        savingPayApi.value = false;
      }
    }

    // ===== 一键诊断直连 =====
    const debuggingPayApi = ref(false);
    const payApiDebug = ref('');

    async function debugPayApi() {
      debuggingPayApi.value = true;
      payApiDebug.value = '';
      try {
        const res = await callAdmin('debugPayApi', {});
        if (res.success && res.diagnostics) {
          const d = res.diagnostics;
          const lines = [
            '【直连凭证】' + (d.credentialsSaved ? '✅ 已保存' : '❌ 未保存'),
            '【商户号】' + (d.mchId || '-'),
            '【密钥长度】' + (d.keyLength || 0) + (d.keyLength === 32 ? ' ✅' : ' ❌ 应为32位'),
            '【证书】' + (d.certLoad ? d.certLoad : (d.certBase64Length ? '已上传 ' + Math.round(d.certBase64Length * 3 / 4 / 1024 * 10) / 10 + 'KB' : '❌ 未上传')),
            '【测试订单】' + (d.testOrderNo || d.orderQuerySkipped || '-'),
            '【签名验证】' + (d.signature || d.orderQueryError || '未测试'),
            '【模式检查】' + (d.modeCheck || '未测试'),
            '【订单状态】' + (d.orderTradeState ? d.orderTradeState + '（交易号 ' + (d.orderTransactionId || '-') + '）' : (d.orderQueryErrCode ? 'err: ' + d.orderQueryErrCode + ' ' + d.orderQueryErrDes : '')),
          ];
          payApiDebug.value = lines.join('\n');
        } else {
          payApiDebug.value = JSON.stringify(res, null, 2);
          showToast(res.error || '诊断失败', 'error');
        }
      } finally {
        debuggingPayApi.value = false;
      }
    }

    async function previewMigration() {
      migration.previewing = true;
      const res = await callAdmin('migrationPreview');
      migration.previewing = false;
      if (res.success) {
        migration.preview = res.data;
        showToast('迁移预检完成');
      } else {
        showToast(res.error || '迁移预检失败', 'error');
      }
    }

    async function runMigration() {
      if (!migration.preview) {
        showToast('请先执行迁移预检', 'error');
        return;
      }
      const confirmed = confirm('将按预检结果更新线上数据。请确认已完成数据库备份，并继续执行 A/B/C V1 迁移。');
      if (!confirmed) return;
      migration.running = true;
      const res = await callAdmin('runMigration', { confirm: 'MIGRATE_ABC_V1' });
      migration.running = false;
      if (res.success) {
        const result = res.data || res.result || {};
        showToast(`迁移完成：分销员 ${result.agents || 0}，商品 ${result.products || 0}，订单 ${result.orders || 0}`);
        await previewMigration();
      } else {
        showToast(res.error || '迁移失败', 'error');
      }
    }

    async function previewTransactionCleanup() {
      transactionCleanup.previewing = true;
      const res = await callAdmin('transactionCleanupPreview');
      transactionCleanup.previewing = false;
      if (res.success) {
        transactionCleanup.preview = res.data;
        transactionCleanup.confirmText = '';
        showToast('测试交易数据预检完成');
      } else {
        showToast(res.error || '清理预检失败', 'error');
      }
    }

    async function purgeTestTransactions() {
      if (!transactionCleanup.preview) {
        showToast('请先执行清理预检', 'error');
        return;
      }
      if (transactionCleanup.confirmText !== '清空测试订单') {
        showToast('请输入“清空测试订单”进行确认', 'error');
        return;
      }
      const orderCount = Number(transactionCleanup.preview.orders) || 0;
      const confirmed = confirm(`将永久删除 ${orderCount} 条订单及其关联交易数据，此操作不可恢复。确定继续吗？`);
      if (!confirmed) return;
      transactionCleanup.running = true;
      const res = await callAdmin('purgeTestTransactions', {
        confirm: 'PURGE_TEST_TRANSACTIONS',
        expectedOrderCount: orderCount
      });
      transactionCleanup.running = false;
      if (res.success) {
        localStorage.removeItem('adminDashboardCache');
        transactionCleanup.preview = null;
        transactionCleanup.confirmText = '';
        showToast(`已清理 ${orderCount} 条测试订单`);
        await loadDashboard();
      } else {
        showToast(res.error || '清理失败', 'error');
        await previewTransactionCleanup();
      }
    }

    // ===== Agents =====
    async function loadAgents() {
      const res = await callAdmin('agentList', { statusFilter: agentFilter.value });
      if (res.success) {
        agents.value = res.data;
      }
    }

    function switchAgentFilter(val) {
      agentFilter.value = val;
      loadAgents();
    }

    function agentStatusText(status) {
      const map = { pending: '待审核', active: '已通过', rejected: '已拒绝' };
      return map[status] || status || '-';
    }

    function agentStatusClass(status) {
      const map = { pending: 'status-pending', active: 'status-paid', rejected: 'status-cancelled' };
      return map[status] || 'status-cancelled';
    }

    async function approveAgent(agent, approve) {
      const name = (agent.agentInfo && agent.agentInfo.name) || agent.nickName || '该分销员';
      if (!confirm(`确定${approve ? '通过' : '拒绝'}「${name}」的分销员申请？`)) return;
      const res = await callAdmin('approveAgent', { userId: agent._id, approve });
      if (res.success) {
        showToast(approve ? '已通过分销员申请' : '已拒绝分销员申请');
        loadAgents();
        loadDashboard();
      } else {
        showToast(res.error || '操作失败', 'error');
      }
    }

    // ===== Withdrawals =====
    async function loadWithdrawals() {
      const res = await callAdmin('withdrawalList', { statusFilter: withdrawalFilter.value });
      if (res.success) {
        withdrawals.value = res.data;
      }
    }

    function switchWithdrawalFilter(val) {
      withdrawalFilter.value = val;
      loadWithdrawals();
    }

    function withdrawalStatusText(status) {
      const map = {
        pending: '待处理',
        pending_pay: '已审核·待打款',
        transferring: '转账中·待确认收款',
        success: '已到账',
        approved: '已通过(线下)',
        rejected: '已拒绝'
      };
      return map[status] || status || '-';
    }

    function withdrawalStatusClass(status) {
      const map = {
        pending: 'status-pending',
        pending_pay: 'status-pending',
        transferring: 'status-refunding',
        success: 'status-paid',
        approved: 'status-paid',
        rejected: 'status-cancelled'
      };
      return map[status] || 'status-cancelled';
    }

    function withdrawalMethodText(wd) {
      if (wd.bankInfo && wd.bankInfo.cardNo) {
        return `银行 ${wd.bankInfo.bank} ${wd.bankInfo.cardNo.slice(-4)}`;
      }
      if (wd.alipayInfo && wd.alipayInfo.account) {
        return `支付宝 ${wd.alipayInfo.account.slice(-4)}`;
      }
      if (wd.account) {
        return `收款账号 ${wd.account}`;
      }
      return wd.method || '未填写';
    }

    function openWithdrawalModal(wd, approve) {
      withdrawalModal.data = wd;
      withdrawalModal.approve = approve;
      withdrawalModal.remark = '';
      withdrawalModal.show = true;
    }

    function viewWithdrawal(wd) {
      withdrawalModal.data = wd;
      withdrawalModal.approve = ['pending', 'pending_pay'].includes(wd.status);
      withdrawalModal.remark = wd.remark || '';
      withdrawalModal.show = true;
    }

    async function retryWithdrawalTransfer(wd) {
      if (processingAction.value) return;
      processingAction.value = true;
      const res = await callAdmin('processWithdrawal', {
        withdrawalId: wd._id,
        approve: true,
        remark: ''
      });
      processingAction.value = false;
      if (res.success) {
        showToast(res.message || '已发起转账');
        loadWithdrawals();
      } else {
        showToast(res.error || '重试失败', 'error');
      }
    }

    async function queryTransferStatus(wd) {
      if (processingAction.value) return;
      processingAction.value = true;
      const res = await callAdmin('queryWithdrawalTransfer', { withdrawalId: wd._id });
      processingAction.value = false;
      if (res.success) {
        showToast(res.message || ('批次状态：' + res.batchStatus));
        loadWithdrawals();
      } else {
        showToast(res.error || '查询失败', 'error');
      }
    }

    async function confirmWithdrawal() {
      processingAction.value = true;
      const res = await callAdmin('processWithdrawal', {
        withdrawalId: withdrawalModal.data._id,
        approve: withdrawalModal.approve,
        remark: withdrawalModal.remark
      });
      processingAction.value = false;
      if (res.success) {
        showToast(res.message || '处理成功', res.inventoryRestockStatus === 'pending_exception' ? 'warning' : 'success');
        withdrawalModal.show = false;
        loadWithdrawals();
        loadDashboard();
      } else {
        showToast(res.error || '操作失败', 'error');
      }
    }

    // ===== Refunds =====
    async function openRefundOperatorQr() {
      if (!currentAccount.value || !['owner', 'finance'].includes(currentAccount.value.role) || refundOperatorQr.loading) return;
      Object.assign(refundOperatorQr, { show: true, loading: true, image: '', error: '' });
      try {
        const result = await callAdminQrAuth('createQrLogin');
        if (!result || !result.success || !result.qrDataUrl) throw new Error((result && result.error) || '二维码生成失败');
        refundOperatorQr.image = result.qrDataUrl;
      } catch (err) { refundOperatorQr.error = err.message || '二维码生成失败'; }
      finally { refundOperatorQr.loading = false; }
    }

    function recordRefundDiagnostic(rf, action, result) {
      const previous = refundDiagnostics[rf._id];
      const data = result && result.data;
      let detail = result && result.success
        ? `${(data && data.status) || ''} ${(data && data.message) || result.message || '操作完成'}`
        : `${(result && result.code) || ''} ${(result && result.error) || '未收到有效返回，状态未知'}`;
      // 附带直连通道诊断信息（直连失败原因 + 走的哪个通道）
      if (result && result.directApiError) {
        detail += `\n[直连诊断] ${result.directApiError}`;
      }
      if (result && result.channel) {
        detail += `\n[退款通道] ${result.channel}`;
      } else if (result && result.fallback) {
        detail += `\n[退款通道] 降级(${result.fallback})`;
      }
      const entry = `${new Date().toLocaleString()} · ${action}\n${detail}${data && data.outRefundNo ? '\n退款单号：' + data.outRefundNo : ''}`;
      const entries = ((previous && previous.entries) || []).concat([entry]).slice(-10);
      refundDiagnostics[rf._id] = { entries, text: entries.join('\n\n'),
        orderNo: (rf.order && rf.order.orderNo) || rf.orderId || '',
        isError: !(result && result.success) };
    }

    async function queryRefundStatus(rf) {
      if (!rf || !rf._id || queryingRefundId.value || processingAction.value) return;
      queryingRefundId.value = rf._id;
      try {
        const result = await callAdmin('queryRefundStatus', { refundId: rf._id });
        if (result && /unknown action/i.test(result.error || '')) {
          result.error = '云端尚未部署退款查询接口，请更新 admin 云函数（包含 refund-query.js）；本次没有发起退款。';
        }
        recordRefundDiagnostic(rf, '只读查询', result);
      } catch (err) {
        recordRefundDiagnostic(rf, '只读查询', { success: false, error: err.message || '查询异常' });
      } finally {
        queryingRefundId.value = '';
      }
    }

    async function copyRefundDiagnostic(id) {
      const info = refundDiagnostics[id];
      if (!info) return;
      try {
        await navigator.clipboard.writeText(`订单号：${info.orderNo}\n${info.text}`);
        showToast('诊断信息已复制');
      } catch (err) {
        showToast('无法自动复制，请选中诊断文字手动复制', 'error');
      }
    }

    async function loadRefunds() {
      const res = await callAdmin('refundList', { statusFilter: refundFilter.value });
      if (res.success) {
        refunds.value = res.data;
      }
    }

    function switchRefundFilter(val) {
      refundFilter.value = val;
      loadRefunds();
    }

    function refundStatusText(status) {
      const map = { pending: '待审批', pending_auto: '已批准待执行', processing: '正在核对', channel_processing: '渠道处理中', manual_review: '待人工核查', approved: '已退款', rejected: '已拒绝' };
      return map[status] || status || '-';
    }

    function refundStatusClass(status) {
      const map = { pending: 'status-refunding', pending_auto: 'status-refunding', processing: 'status-refunding', channel_processing: 'status-shipped', manual_review: 'status-refunding', approved: 'status-refunded', rejected: 'status-cancelled' };
      return map[status] || 'status-cancelled';
    }

    function refundChannelLabel(rf) {
      if (!rf) return '';
      const ch = rf.refundChannel;
      if (ch === 'wechat_manual') return '🟡 人工处理';
      if (ch === 'mock') return '🔵 模拟退款';
      if (ch === 'wechat') return '🟢 微信已退';
      return '';
    }

    function refundChannelClass(rf) {
      if (!rf) return '';
      const ch = rf.refundChannel;
      if (ch === 'wechat_manual') return 'status-refunding';
      if (ch === 'mock') return 'status-cancelled';
      if (ch === 'wechat') return 'status-paid';
      return '';
    }

    function openRefundModal(rf, approve) {
      if (processingAction.value || queryingRefundId.value) return;
      refundModal.readOnly = rf.status !== 'pending';
      refundModal.data = rf;
      refundModal.approve = approve;
      refundModal.adminNote = '';
      refundModal.returnReceived = rf.type !== 'return_refund';
      refundModal.restock = rf.type === 'refund_only';
      refundModal.show = true;
    }

    function viewRefund(rf) {
      if (processingAction.value || queryingRefundId.value) return;
      openRefundModal(rf, true);
      refundModal.readOnly = true;
      refundModal.adminNote = rf.adminNote || '';
      refundModal.show = true;
    }

    // 重试「待人工核查」的退款（例如商户余额不足被拒后，充值完毕再试；微信按退款单号幂等不会重复退款）
    async function retryRefund(rf) {
      if (processingAction.value || queryingRefundId.value || !rf) return;
      processingAction.value = true;
      try {
        const res = await callAdmin('retryRefund', { refundId: rf._id });
        recordRefundDiagnostic(rf, '重试退款', res);
        if (res && res.success) {
          showToast(res.message || '重试成功', res.channelAccepted || res.inventoryRestockStatus === 'pending_exception' ? 'warning' : 'success', 6000);
        } else {
          showToast((res && res.error) || '重试失败，详情已保留', 'error', 8000);
        }
        loadRefunds();
        loadDashboard();
      } catch (err) {
        recordRefundDiagnostic(rf, '重试退款异常', { success: false, error: err.message || '状态未知，请勿重复退款' });
      } finally {
        processingAction.value = false;
      }
    }

    async function confirmRefund() {
      if (processingAction.value || queryingRefundId.value || refundModal.readOnly || !refundModal.data || refundModal.data.status !== 'pending') return;
      const rf = refundModal.data;
      processingAction.value = true;
      try {
        // 同意即直连微信退款 API 原路退回买家；仅直连凭证未配置时回退手机入口流程。
        const res = await callAdmin('processRefund', {
          refundId: rf._id,
          approve: refundModal.approve,
          adminNote: refundModal.adminNote,
          returnReceived: refundModal.returnReceived,
          restock: refundModal.restock
        });
        recordRefundDiagnostic(rf, refundModal.approve ? '申请退款' : '拒绝退款', res);
        if (res && res.success) {
          if (res.autoProcessing) {
            showToast(res.message || '退款已批准但尚未到账，请使用手机退款入口处理并核对', 'success', 6000);
          } else if (res.fallback === 'wechat_manual') {
            showToast(res.message || '退款已批准（人工处理模式）', 'warning', 6000);
            if (res.warning) {
              setTimeout(() => showToast(res.warning, 'warning', 8000), 200);
            }
          } else {
            showToast(res.message || '处理成功', res.inventoryRestockStatus === 'pending_exception' ? 'warning' : 'success');
          }
          refundModal.show = false;
          loadRefunds();
          loadDashboard();
          // 自动处理中：60秒后自动刷新一次看结果
          if (res.autoProcessing) {
            setTimeout(() => { loadRefunds(); loadDashboard(); }, 60000);
          }
        } else {
          showToast((res && res.error) || '操作失败，详情已保留', 'error');
        }
      } catch (err) {
        recordRefundDiagnostic(rf, '退款操作异常', { success: false, error: err.message || '状态未知，请勿重复退款' });
      } finally {
        processingAction.value = false;
      }
    }

    // ===== 初始化 =====
    onMounted(async () => {
      const loadingShell = document.getElementById('loading-shell');
      if (loadingShell) loadingShell.remove();
      document.addEventListener('visibilitychange', handleVisibilityChange);
      if (isLoggedIn.value) {
        const state = await auth.getLoginState().catch(() => null);
        const validSession = state ? await loadDashboard() : false;
        if (!validSession) {
          localStorage.removeItem('adminToken');
          localStorage.removeItem('adminAccount');
          currentAccount.value = null;
          isLoggedIn.value = false;
          await auth.signOut().catch(() => {});
          startQrLogin();
        }
      } else {
        startQrLogin();
      }
    });

    onBeforeUnmount(() => {
      stopQrTimers();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    });

    return {
      // 全局
      isLoggedIn, loading, loginError, qrLogin, currentPage, pages, toast, currentAccount,
      // dashboard
      stats, recentOrders, finance, financeError, financeLoading, inventory, invites, inviteForm, accounts, accountForm,
      // orders
      orders, orderFilter, orderFilters, shipModal, orderDetailModal,
      // products
      products, productModal,
      // agents
      agents, agentFilter, agentFilters,
      // withdrawals
      withdrawals, withdrawalFilter, withdrawalFilters, withdrawalModal,
      // refunds
      refunds, refundFilter, refundFilters, refundModal, processingAction, refundDiagnostics, queryingRefundId,
      queryRefundStatus, copyRefundDiagnostic, refundOperatorQr, openRefundOperatorQr,
      // messages
      messageUsers, currentChatUser, currentChatUserName, chatMessages, replyText, chatBox,
      // settings
      settings, pwdForm, newOpenId, migration, transactionCleanup,
      // methods
      startQrLogin, logout, switchPage,
      loadDashboard, loadOrders, switchOrderFilter, openShipModal, confirmShip, viewOrder, formatOrderAddress,
      loadProducts, openProductModal, saveProduct, toggleProduct, deleteProduct,
      loadInventory, adjustInventory, loadFinance,
      loadInvites, createInvite, revokeInvite, inviteQrModal, openInviteQr, closeInviteQr,
      loadAccounts, createAccount, toggleAccount,
      loadAgents, switchAgentFilter, approveAgent, agentStatusText, agentStatusClass,
      loadWithdrawals, switchWithdrawalFilter, withdrawalStatusText, withdrawalStatusClass, withdrawalMethodText, openWithdrawalModal, viewWithdrawal, confirmWithdrawal, retryWithdrawalTransfer, queryTransferStatus,
      loadRefunds, switchRefundFilter, refundStatusText, refundStatusClass, refundChannelLabel, refundChannelClass, openRefundModal, viewRefund, confirmRefund, retryRefund,
      loadMessageUsers, selectChatUser, sendReply,
      loadSettings, changePassword, addAdminOpenId, removeAdminOpenId, saveCommissionRate,
      payApiForm, savingPayApi, onPayCertFileChange, savePayApiConfig, clearPayApiConfig,
      debuggingPayApi, payApiDebug, debugPayApi,
      fullReduction, addFullReductionRule, removeFullReductionRule, saveFullReduction,
      previewMigration, runMigration, previewTransactionCleanup, purgeTestTransactions,
      // utils
      formatPrice, formatTime, statusText, orderItemsText
    };
  }
};

createApp(App).mount('#app');
