<script setup lang="ts">
import { NCard } from 'naive-ui/es/card'
import { NModal } from 'naive-ui/es/modal'
import { NTab, NTabs } from 'naive-ui/es/tabs'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import api, { getApiErrorMessage } from '@/api'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import { useAccountStore } from '@/stores/account'

defineEmits<{ back: [] }>()
const account = useAccountStore()
const state = ref<any>(null)
const busy = ref(false)
const error = ref('')
const feedback = ref('')
const needsRefresh = ref(false)
const tab = ref('stall')
const target = ref('')
const count = ref<string | number>(1)
const acknowledge = ref(false)
const confirm = ref<any>(null)
let generation = 0
const blocked = computed(() => busy.value || needsRefresh.value || !state.value || state.value.pending?.length > 0)
const fmt = (value: any) => String(value ?? '0').replace(/\B(?=(\d{3})+(?!\d))/g, ',')
const date = (value: any) => {
  const numeric = Number(value)
  return numeric > 0 ? new Date(numeric > 100000000000 ? numeric : numeric * 1000).toLocaleString('zh-CN', { hour12: false }) : '-'
}

async function request(action?: string, input: Record<string, unknown> = {}) {
  const id = String(account.currentAccountId || '')
  if (!id || busy.value)
    return
  const version = ++generation
  busy.value = true
  error.value = ''
  feedback.value = ''
  try {
    const options: any = { headers: { 'x-account-id': id }, skipErrorToast: true, timeout: 120000 }
    const params = { targetGid: target.value.trim() || undefined, records: tab.value === 'records' }
    const response = action
      ? await api.post(`/api/activities/maple/${action}`, { ...params, ...input }, options)
      : await api.get('/api/activities/maple', { ...options, params })
    if (version !== generation || id !== String(account.currentAccountId || ''))
      return
    if (!response.data?.ok)
      throw new Error(response.data?.error || '活动请求失败')
    const result = response.data.data
    state.value = action ? result.activity : result
    needsRefresh.value = action ? result.refreshRequired === true : false
    if (action) {
      feedback.value = result.acknowledged ? '核对记录已解除' : `操作已确认${(result.rewards || []).length ? `：${result.rewards.map((item: any) => `${item.name} ×${fmt(item.count)}`).join('、')}` : ''}`
    }
    if (needsRefresh.value)
      error.value = '操作已确认，页面刷新失败，请刷新后继续。'
  }
  catch (cause) {
    if (version === generation) {
      error.value = getApiErrorMessage(cause, '请求失败，请刷新并核对结果')
      if (action)
        needsRefresh.value = true
    }
  }
  finally {
    if (version === generation)
      busy.value = false
  }
}
function promptSell() {
  if (blocked.value || !state.value?.shop.canSell)
    return
  confirm.value = { action: 'sell', operationId: `${Date.now()}-${Math.random().toString(36).slice(2)}-maple`, count: String(count.value), expectedPrice: state.value.shop.price,
    targetGid: state.value.targetGid, title: '确认出售蜜薯', detail: `${state.value.shop.owner} · 每个 ${fmt(state.value.shop.price)} 福气币 · 数量 ${fmt(count.value)}` }
}
function promptExchange(good: any) {
  confirm.value = { action: 'exchange', operationId: `${Date.now()}-${Math.random().toString(36).slice(2)}-maple`, goodsId: good.id, count: '1', expectedPrice: good.price,
    title: `兑换${good.name}`, detail: `消耗 ${fmt(good.price)} 福气币，兑换 1 份` }
}
async function submit() {
  const choice = confirm.value
  if (!choice || blocked.value)
    return
  confirm.value = null
  await request(choice.action, { ...choice, confirmed: true })
}
function claim(action: string) {
  void request(action, { operationId: `${Date.now()}-${Math.random().toString(36).slice(2)}-maple` })
}
function ownShop() {
  target.value = ''
  void request()
}
watch(() => account.currentAccountId, () => {
  generation++
  state.value = null
  busy.value = false
  needsRefresh.value = false
  confirm.value = null
  target.value = ''
  tab.value = 'stall'
  acknowledge.value = false
  void request()
}, { immediate: true, flush: 'sync' })
watch(tab, () => { confirm.value = null; void request() })
onBeforeUnmount(() => { generation++ })
</script>

<template>
  <div class="maple-page page-stack">
    <header class="maple-header">
      <div class="flex items-center gap-3">
        <BaseButton variant="text" title="返回活动列表" @click="$emit('back')"><span class="i-carbon-arrow-left text-xl" /></BaseButton>
        <div><h1 class="text-xl font-bold">以薯换福</h1><p v-if="state" class="text-xs text-gray-500">{{ date(state.start) }} — {{ date(state.end) }}</p></div>
      </div>
      <BaseButton :loading="busy" variant="secondary" @click="request()"><span class="i-carbon-renew mr-1" />刷新</BaseButton>
    </header>
    <p v-if="error" role="alert" class="text-sm text-red-600">{{ error }}</p>
    <p v-if="feedback" role="status" class="text-sm text-green-700">{{ feedback }}</p>
    <p v-if="!account.currentAccountId" class="py-8 text-center text-gray-500">请先选择账号</p>
    <p v-else-if="!state && busy" class="py-8 text-center text-gray-500">正在读取活动…</p>
    <template v-if="state">
      <section v-if="state.pending?.length" class="maple-pending" aria-label="待核对操作">
        <h2 class="font-bold">存在结果待核对的操作</h2>
        <p class="text-sm">请先在游戏中确认余额、出售记录或奖励是否已到账，再解除对应保护。解除后可再次操作。</p>
        <label class="flex items-center gap-2 text-sm"><input v-model="acknowledge" type="checkbox">我已在游戏内核对结果</label>
        <div v-for="row in state.pending" :key="row.id" class="flex flex-wrap items-center gap-3">
          <span class="text-sm">{{ date(row.createdAt) }} · {{ row.action }}</span>
          <BaseButton size="sm" :disabled="busy || !acknowledge" @click="request('acknowledge', { operationId: row.id, confirmed: true })">解除此条保护</BaseButton>
        </div>
      </section>
      <section class="maple-balances">
        <div><img v-if="state.cropItem.image" :src="state.cropItem.image" alt="蜜薯"><span class="text-sm text-gray-500">蜜薯库存</span><strong>{{ fmt(state.crop) }}</strong></div>
        <div><img v-if="state.currencyItem.image" :src="state.currencyItem.image" alt="福气币"><span class="text-sm text-gray-500">福气币</span><strong>{{ fmt(state.currency) }}</strong></div>
        <div><span class="text-sm text-gray-500">待领取佣金</span><strong>{{ fmt(state.commission) }}</strong></div>
      </section>
      <NTabs v-model:value="tab" type="line">
        <NTab name="stall">红薯小铺</NTab><NTab name="shop">兑换商店</NTab><NTab name="records">收购记录</NTab><NTab name="rules">活动规则</NTab>
      </NTabs>
      <section v-if="tab === 'stall'" class="maple-stall">
        <div class="flex flex-wrap items-end gap-2">
          <BaseInput v-model="target" label="目标小铺 GID" placeholder="留空查看自己的小铺" class="min-w-0 flex-1" :disabled="busy" />
          <BaseButton :disabled="busy" @click="request()">查看小铺</BaseButton><BaseButton variant="secondary" :disabled="busy" @click="ownShop">我的小铺</BaseButton>
        </div>
        <div class="maple-price">
          <p class="text-sm text-gray-500">{{ state.shop.owner }} · 当前收购价</p>
          <strong>{{ fmt(state.shop.price) }}<small>福气币 / 个</small></strong>
          <p class="text-sm text-gray-500">基础价 {{ fmt(state.shop.basePrice) }} + 加成 {{ fmt(state.shop.boost) }}</p>
          <p class="text-sm">今日还可收购 {{ fmt(state.shop.quota) }} 个<span v-if="state.shop.self">（出售给自己不受此额度限制）</span></p>
        </div>
        <div class="flex flex-wrap items-end gap-3">
          <BaseInput v-model="count" label="出售数量" type="number" min="1" :max="Math.min(Number.MAX_SAFE_INTEGER, Number(state.shop.maxSell))" :disabled="blocked || !state.shop.canSell" />
          <BaseButton :disabled="blocked || !state.shop.canSell || Number(count) < 1 || Number(count) > Number(state.shop.maxSell)" @click="promptSell">出售蜜薯</BaseButton>
        </div>
        <div class="flex flex-wrap gap-2">
          <BaseButton variant="secondary" :disabled="blocked || !state.active || state.seedClaimed" @click="claim('claimSeed')">{{ state.seedClaimed ? '今日种子已领取' : `领取今日种子 ×${state.seedItem.count}` }}</BaseButton>
          <BaseButton variant="secondary" :disabled="blocked || !state.active || state.commissionCount === '0'" @click="claim('claimCommission')">领取佣金</BaseButton>
        </div>
        <p v-if="!state.active" class="text-sm text-gray-500">{{ state.settling ? '活动结算期，仅保留兑换。' : '当前活动未开放。' }}</p>
      </section>
      <section v-else-if="tab === 'shop'" class="maple-goods">
        <article v-for="good in state.goods" :key="good.id" class="maple-good">
          <img v-if="good.items[0]?.image" :src="good.items[0].image" :alt="good.name" loading="lazy">
          <h2 class="font-bold">{{ good.name }}</h2>
          <p class="text-sm">{{ fmt(good.price) }} 福气币</p>
          <p class="text-xs text-gray-500">{{ good.remaining === null ? '不限购' : `${good.limitType === 1 ? '今日' : '活动'}剩余 ${fmt(good.remaining)} 份` }}</p>
          <BaseButton size="sm" :disabled="blocked || !(state.active || state.settling) || !good.available || Number(good.price) > Number(state.currency)" @click="promptExchange(good)">兑换 1 份</BaseButton>
        </article>
      </section>
      <section v-else-if="tab === 'records'" class="overflow-x-auto">
        <p v-if="!state.records?.length" class="py-8 text-center text-gray-500">暂无收购记录</p>
        <table v-else class="maple-table"><thead><tr><th>时间</th><th>出售者</th><th>数量</th><th>福气币收入</th><th>铺主佣金</th></tr></thead><tbody><tr v-for="(row, index) in state.records" :key="index"><td>{{ date(row.time) }}</td><td>{{ row.name }}</td><td>{{ fmt(row.count) }}</td><td>{{ fmt(row.income) }}</td><td>{{ fmt(row.commission) }}</td></tr></tbody></table>
      </section>
      <section v-else class="text-sm leading-7"><p v-for="(line, i) in state.rules" :key="i" class="whitespace-pre-wrap">{{ line }}</p><p v-if="!state.rules.length">活动规则以游戏内说明为准。</p></section>
    </template>
    <NModal :show="!!confirm" @update:show="value => !value && (confirm = null)">
      <NCard class="maple-confirm" :title="confirm?.title" :bordered="false" closable @close="confirm = null">
        <p>{{ confirm?.detail }}</p>
        <p v-if="confirm?.action === 'sell'" class="mt-2 text-sm text-gray-500">好友的小铺可能价格更高。提交时会重新检查价格，最终收益以实际回包为准。</p>
        <div class="mt-5 flex justify-end gap-2"><BaseButton variant="secondary" @click="confirm = null">取消</BaseButton><BaseButton :disabled="blocked" @click="submit">确认</BaseButton></div>
      </NCard>
    </NModal>
  </div>
</template>

<style scoped>
.maple-page{min-width:0;display:flex;flex-direction:column;gap:18px;padding-bottom:100px}
.maple-header{display:flex;justify-content:space-between;align-items:center;gap:10px}
.maple-balances{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;border-block:1px solid var(--ui-border,#ddd);padding:18px 0}
.maple-balances strong{display:block;font-size:24px;overflow-wrap:anywhere}
.maple-balances img{height:32px;width:32px;object-fit:contain;display:block;margin-bottom:6px}
.maple-stall{display:flex;flex-direction:column;gap:20px}
.maple-price{padding:20px 0;border-bottom:1px solid var(--ui-border,#ddd)}
.maple-price strong{display:block;font-size:38px;color:#24815b}.maple-price small{font-size:14px;margin-left:12px}
.maple-goods{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px}
.maple-good{border:1px solid var(--ui-border,#ddd);border-radius:8px;padding:16px;display:flex;flex-direction:column;gap:10px;background:var(--ui-surface,#fff);min-width:0}
.maple-good img{height:56px;width:56px;object-fit:contain}.maple-good h2{overflow-wrap:anywhere}
.maple-pending{padding:16px;border:1px solid #d4a342;border-radius:8px;display:flex;flex-direction:column;gap:12px}
.maple-table{width:100%;border-collapse:collapse;font-size:13px}.maple-table th,.maple-table td{text-align:left;border-bottom:1px solid var(--ui-border,#ddd);padding:12px 8px;min-width:80px}
.maple-confirm{width:min(480px,calc(100vw - 28px));border-radius:8px}
@media(max-width:600px){.maple-balances strong{font-size:20px}.maple-balances span{font-size:12px}.maple-price strong{font-size:32px}.maple-header h1{font-size:20px}.maple-goods{grid-template-columns:repeat(2,minmax(0,1fr))}.maple-good{padding:12px}}
</style>
