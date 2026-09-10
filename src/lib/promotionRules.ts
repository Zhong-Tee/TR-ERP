export type PromotionRuleType =
  | 'legacy'
  | 'bundle_fixed_price'
  | 'spend_percent'
  | 'spend_fixed'
  | 'buy_get'
  | 'spend_get'
  | 'quantity_get'

export type PromotionSelector =
  | { selector_type: 'category'; category: string; product_id?: never }
  | { selector_type: 'sku'; product_id: string; category?: never }

export type PromotionRuleGroup = {
  id: string
  quantity: number
  options: PromotionSelector[]
}

export type PromotionRuleConfig = {
  threshold_amount?: number
  discount_value?: number
  set_price?: number
  max_applications?: number
  condition_groups?: PromotionRuleGroup[]
  reward_groups?: PromotionRuleGroup[]
}

export type PromotionDefinition = {
  id: string
  name: string
  is_active: boolean
  validation_enabled: boolean
  rule_type: PromotionRuleType
  start_date?: string | null
  end_date?: string | null
  channel_codes?: string[] | null
  rule_config?: PromotionRuleConfig | null
  allow_stack?: boolean
  is_featured?: boolean
  free_shipping?: boolean
  version?: number
  sort_order?: number | null
}

export type PromotionOrderItem = {
  product_id?: string | null
  product_name?: string | null
  product_category?: string | null
  quantity?: number | null
  unit_price?: number | null
  is_free?: boolean | null
}

export type PromotionEvaluation = {
  promotion_id: string
  promotion_name: string
  passed: boolean
  checked: boolean
  messages: string[]
  expected_discount: number
  application_count: number
}

const money = (value: number) => Math.round((Number(value) || 0) * 100) / 100
const positiveInt = (value: unknown, fallback = 1) => {
  const parsed = Math.floor(Number(value))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function optionMatches(item: PromotionOrderItem, option: PromotionSelector): boolean {
  if (option.selector_type === 'sku') return !!item.product_id && item.product_id === option.product_id
  return !!item.product_category && item.product_category === option.category
}

function groupMatches(item: PromotionOrderItem, group: PromotionRuleGroup): boolean {
  return group.options.some((option) => optionMatches(item, option))
}

/**
 * จัดสรรจำนวนสินค้าให้แต่ละกลุ่มแบบ AND โดยตัวเลือกในกลุ่มเป็น OR
 * ใช้ min-cost max-flow เพื่อเลือกชุดสินค้าที่มูลค่าสูงสุดโดยยังผ่านครบทุกกลุ่ม
 * และห้ามใช้จำนวนชิ้นเดิมซ้ำภายในหนึ่งรอบโปรโมชั่น
 */
function allocateGroups(
  source: PromotionOrderItem[],
  groups: PromotionRuleGroup[],
): { passed: boolean; subtotal: number; missing: string[] } {
  if (!groups.length) return { passed: true, subtotal: 0, missing: [] }
  type Edge = { to: number; reverse: number; capacity: number; cost: number }
  const itemCount = source.length
  const sourceNode = 0
  const firstItemNode = 1
  const firstGroupNode = firstItemNode + itemCount
  const sinkNode = firstGroupNode + groups.length
  const graph: Edge[][] = Array.from({ length: sinkNode + 1 }, () => [])
  const addEdge = (from: number, to: number, capacity: number, cost: number) => {
    const forward: Edge = { to, reverse: graph[to].length, capacity, cost }
    const reverse: Edge = { to: from, reverse: graph[from].length, capacity: 0, cost: -cost }
    graph[from].push(forward)
    graph[to].push(reverse)
    return forward
  }

  source.forEach((item, itemIndex) => {
    const quantity = Math.max(0, Math.floor(Number(item.quantity) || 0))
    if (!quantity) return
    const itemNode = firstItemNode + itemIndex
    addEdge(sourceNode, itemNode, quantity, 0)
    groups.forEach((group, groupIndex) => {
      if (groupMatches(item, group)) {
        addEdge(itemNode, firstGroupNode + groupIndex, quantity, -Math.round(Number(item.unit_price || 0) * 100))
      }
    })
  })
  const groupDemandEdges = groups.map((group, groupIndex) =>
    addEdge(firstGroupNode + groupIndex, sinkNode, positiveInt(group.quantity), 0),
  )
  const totalDemand = groups.reduce((sum, group) => sum + positiveInt(group.quantity), 0)
  let totalFlow = 0
  let totalCost = 0

  while (totalFlow < totalDemand) {
    const distance = Array(graph.length).fill(Number.POSITIVE_INFINITY) as number[]
    const previousNode = Array(graph.length).fill(-1) as number[]
    const previousEdge = Array(graph.length).fill(-1) as number[]
    const queued = Array(graph.length).fill(false) as boolean[]
    const queue = [sourceNode]
    distance[sourceNode] = 0
    queued[sourceNode] = true
    while (queue.length) {
      const node = queue.shift()!
      queued[node] = false
      graph[node].forEach((edge, edgeIndex) => {
        if (edge.capacity <= 0 || distance[edge.to] <= distance[node] + edge.cost) return
        distance[edge.to] = distance[node] + edge.cost
        previousNode[edge.to] = node
        previousEdge[edge.to] = edgeIndex
        if (!queued[edge.to]) {
          queue.push(edge.to)
          queued[edge.to] = true
        }
      })
    }
    if (previousNode[sinkNode] < 0) break
    let flow = totalDemand - totalFlow
    for (let node = sinkNode; node !== sourceNode; node = previousNode[node]) {
      flow = Math.min(flow, graph[previousNode[node]][previousEdge[node]].capacity)
    }
    for (let node = sinkNode; node !== sourceNode; node = previousNode[node]) {
      const edge = graph[previousNode[node]][previousEdge[node]]
      edge.capacity -= flow
      graph[node][edge.reverse].capacity += flow
      totalCost += flow * edge.cost
    }
    totalFlow += flow
  }

  const missing = groups.flatMap((group, index) => {
    const shortage = groupDemandEdges[index].capacity
    return shortage > 0 ? [`กลุ่ม ${group.id || '-'} ขาด ${shortage} ชิ้น`] : []
  })
  return { passed: missing.length === 0, subtotal: money(-totalCost / 100), missing }
}

function eligibilityMessages(
  promotion: PromotionDefinition,
  channelCode: string,
  orderDate: string,
): string[] {
  const messages: string[] = []
  if (!promotion.is_active) messages.push('โปรโมชั่นถูกปิดใช้งาน')
  const channels = promotion.channel_codes || []
  if (channels.length && !channels.includes(channelCode)) messages.push(`ไม่รองรับช่องทาง ${channelCode}`)
  if (promotion.start_date && orderDate < promotion.start_date) messages.push(`โปรโมชั่นเริ่มวันที่ ${promotion.start_date}`)
  if (promotion.end_date && orderDate > promotion.end_date) messages.push(`โปรโมชั่นสิ้นสุดวันที่ ${promotion.end_date}`)
  return messages
}

export function evaluatePromotion(
  promotion: PromotionDefinition,
  items: PromotionOrderItem[],
  context: { channel_code: string; order_date?: string; order_subtotal?: number },
): PromotionEvaluation {
  const config = promotion.rule_config || {}
  const orderDate = context.order_date || new Date().toISOString().slice(0, 10)
  const paidItems = items.filter((item) => !item.is_free && Number(item.quantity || 0) > 0)
  const freeItems = items.filter((item) => !!item.is_free && Number(item.quantity || 0) > 0)
  const subtotal = money(
    context.order_subtotal ?? paidItems.reduce((sum, item) => sum + Number(item.quantity || 0) * Number(item.unit_price || 0), 0),
  )
  const messages = eligibilityMessages(promotion, context.channel_code, orderDate)
  let expectedDiscount = 0
  let applicationCount = 0

  if (promotion.rule_type === 'legacy') {
    return {
      promotion_id: promotion.id,
      promotion_name: promotion.name,
      passed: messages.length === 0,
      checked: false,
      messages,
      expected_discount: 0,
      application_count: 0,
    }
  }

  if (messages.length === 0) {
    const threshold = Math.max(0, Number(config.threshold_amount) || 0)
    const conditionGroups = config.condition_groups || []
    const rewardGroups = config.reward_groups || []

    if (promotion.rule_type === 'spend_percent' || promotion.rule_type === 'spend_fixed') {
      if (subtotal < threshold) {
        messages.push(`ยอดสินค้าไม่ถึง ${money(threshold).toLocaleString('th-TH')} บาท (ปัจจุบัน ${subtotal.toLocaleString('th-TH')} บาท)`)
      } else {
        applicationCount = 1
        const value = Math.max(0, Number(config.discount_value) || 0)
        expectedDiscount = promotion.rule_type === 'spend_percent' ? subtotal * (value / 100) : value
      }
    } else if (promotion.rule_type === 'bundle_fixed_price') {
      const allocation = allocateGroups(paidItems, conditionGroups)
      if (!allocation.passed) messages.push(...allocation.missing)
      else {
        applicationCount = 1
        expectedDiscount = Math.max(0, allocation.subtotal - Math.max(0, Number(config.set_price) || 0))
      }
    } else {
      if (promotion.rule_type === 'spend_get' && subtotal < threshold) {
        messages.push(`ยอดสินค้าไม่ถึง ${money(threshold).toLocaleString('th-TH')} บาท (ปัจจุบัน ${subtotal.toLocaleString('th-TH')} บาท)`)
      }
      if (promotion.rule_type !== 'spend_get') {
        const buyAllocation = allocateGroups(paidItems, conditionGroups)
        if (!buyAllocation.passed) messages.push(...buyAllocation.missing.map((m) => `สินค้าฝั่งซื้อ: ${m}`))
      }
      const rewardAllocation = allocateGroups(freeItems, rewardGroups)
      if (!rewardAllocation.passed) messages.push(...rewardAllocation.missing.map((m) => `ของแถม: ${m}`))
      if (messages.length === 0) applicationCount = Math.min(1, positiveInt(config.max_applications))
    }
  }

  return {
    promotion_id: promotion.id,
    promotion_name: promotion.name,
    passed: messages.length === 0,
    // ปิดการตรวจ = ยังคำนวณสิทธิ์/ส่วนลด แต่ไม่ใช้ผลนี้เพื่อเปิด Popup บล็อกผู้ใช้
    checked: promotion.validation_enabled,
    messages,
    expected_discount: money(Math.min(subtotal, Math.max(0, expectedDiscount))),
    application_count: applicationCount,
  }
}

export function evaluatePromotions(
  promotions: PromotionDefinition[],
  items: PromotionOrderItem[],
  context: { channel_code: string; order_date?: string; order_subtotal?: number },
): PromotionEvaluation[] {
  const evaluations = promotions.map((promotion) => evaluatePromotion(promotion, items, context))
  if (promotions.length > 1 && promotions.some((promotion) => promotion.allow_stack === false)) {
    return evaluations.map((result) => ({
      ...result,
      passed: false,
      messages: [...result.messages, 'โปรโมชั่นนี้ไม่สามารถใช้ร่วมกับโปรโมชั่นอื่นได้'],
    }))
  }
  return evaluations
}

export function totalPromotionDiscount(results: PromotionEvaluation[]): number {
  return money(results.reduce((sum, result) => sum + (result.passed ? result.expected_discount : 0), 0))
}

export const PROMOTION_RULE_LABELS: Record<PromotionRuleType, string> = {
  legacy: 'รายการเดิม (ไม่ตรวจเงื่อนไข)',
  bundle_fixed_price: 'เซ็ตหลายรายการ ราคาพิเศษ',
  spend_percent: 'ซื้อครบ X บาท ลด X%',
  spend_fixed: 'ซื้อครบ X บาท ลด X บาท',
  buy_get: 'ซื้อ X แถม Y',
  spend_get: 'ซื้อครบ X บาท รับของแถม',
  quantity_get: 'ซื้อสินค้าที่กำหนด X ชิ้น รับของแถม',
}
