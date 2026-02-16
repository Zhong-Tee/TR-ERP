import { useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { formatDateTime } from '../../lib/utils'
import { Issue, IssueMessage, IssueType, Order } from '../../types'
import { useAuthContext } from '../../contexts/AuthContext'
import Modal from '../ui/Modal'
import OrderDetailView from './OrderDetailView'
import { FiMessageCircle, FiInfo, FiCheckCircle } from 'react-icons/fi'

type IssueBoardProps = {
  scope: 'orders' | 'plan'
  workOrders?: Array<{ work_order_name: string }>
  onOpenCountChange?: (count: number) => void
}

type IssueWithOrder = Issue & {
  order?: Pick<Order, 'id' | 'bill_no' | 'customer_name' | 'channel_code' | 'work_order_name' | 'admin_user'>
  type?: IssueType | null
  creatorName?: string
}

export default function IssueBoard({ scope, workOrders = [], onOpenCountChange }: IssueBoardProps) {
  const { user } = useAuthContext()
  const [loading, setLoading] = useState(true)
  const [issuesOn, setIssuesOn] = useState<IssueWithOrder[]>([])
  const [issuesClosed, setIssuesClosed] = useState<IssueWithOrder[]>([])
  const [types, setTypes] = useState<IssueType[]>([])
  const [chatIssue, setChatIssue] = useState<IssueWithOrder | null>(null)
  const [chatLogs, setChatLogs] = useState<IssueMessage[]>([])
  const [chatLoading, setChatLoading] = useState(false)
  const [chatMessage, setChatMessage] = useState('')
  const [chatSending, setChatSending] = useState(false)
  const [enterToSend, setEnterToSend] = useState(false)
  const [activeTab, setActiveTab] = useState<'on' | 'close'>('on')
  const [, setNewIssueCount] = useState(0)
  const [, setNewChatCount] = useState(0)
  const [detailIssue, setDetailIssue] = useState<IssueWithOrder | null>(null)
  const [updatingIssue, setUpdatingIssue] = useState(false)
  const [detailOrder, setDetailOrder] = useState<Order | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [createWorkOrder, setCreateWorkOrder] = useState('')
  const [createOrderId, setCreateOrderId] = useState('')
  const [createTitle, setCreateTitle] = useState('')
  const [createTypeId, setCreateTypeId] = useState('')
  const [ordersForWorkOrder, setOrdersForWorkOrder] = useState<Order[]>([])
  const [unreadByIssue, setUnreadByIssue] = useState<Record<string, number>>({})
  const [fromDate, setFromDate] = useState(() => new Date().toISOString().split('T')[0])
  const [toDate, setToDate] = useState(() => new Date().toISOString().split('T')[0])
  const [now, setNow] = useState(() => Date.now())
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Tick every 60s so live elapsed time updates for open issues
  useEffect(() => {
    timerRef.current = setInterval(() => setNow(Date.now()), 60_000)
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  }, [])

  /** Format elapsed time as ชม:นาที */
  function formatElapsed(issue: IssueWithOrder): string {
    let mins: number
    if (issue.status === 'Close' && issue.duration_minutes != null) {
      mins = issue.duration_minutes
    } else if (issue.status === 'Close' && issue.closed_at) {
      mins = Math.floor((new Date(issue.closed_at).getTime() - new Date(issue.created_at).getTime()) / 60_000)
    } else {
      mins = Math.floor((now - new Date(issue.created_at).getTime()) / 60_000)
    }
    if (mins < 0) mins = 0
    const h = Math.floor(mins / 60)
    const m = mins % 60
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`
  }

  const workOrderOptions = useMemo(() => {
    const names = workOrders.map((w) => w.work_order_name).filter(Boolean)
    return Array.from(new Set(names)).sort((a, b) => a.localeCompare(b))
  }, [workOrders])

  useEffect(() => {
    loadTypes()
  }, [])

  useEffect(() => {
    loadIssues()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [types.length, fromDate, toDate])

  useEffect(() => {
    const onTabChange = (event: Event) => {
      const detail = (event as CustomEvent<{ tab: 'on' | 'close' }>).detail
      if (detail?.tab) setActiveTab(detail.tab)
    }
    window.addEventListener('issue-tab-change', onTabChange)
    return () => window.removeEventListener('issue-tab-change', onTabChange)
  }, [])

  useEffect(() => {
    const channel = supabase
      .channel(`issue-board-${scope}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'or_issues' }, (payload) => {
        const row = payload.new as Issue
        if (scope === 'plan' && (!row.work_order_name || !workOrderOptions.includes(row.work_order_name))) return
        if (row.status === 'On') setNewIssueCount((prev) => prev + 1)
        loadIssues()
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'or_issue_messages' }, (payload) => {
        const row = payload.new as IssueMessage
        setNewChatCount((prev) => prev + 1)
        if (chatIssue && chatIssue.id === row.issue_id) {
          setChatLogs((prev) => (prev.some((m) => m.id === row.id) ? prev : [...prev, row]))
          if (user && !(user.role === 'superadmin' || user.role === 'admin')) {
            supabase.from('or_issue_reads').upsert({
              issue_id: row.issue_id,
              user_id: user.id,
              last_read_at: new Date().toISOString(),
            })
          }
        }
        if (!chatIssue || chatIssue.id !== row.issue_id) {
          setUnreadByIssue((prev) => ({ ...prev, [row.issue_id]: (prev[row.issue_id] || 0) + 1 }))
        }
      })
      .subscribe()
    return () => {
      supabase.removeChannel(channel)
    }
  }, [scope, workOrderOptions, chatIssue, user])

  async function loadTypes() {
    try {
      const { data, error } = await supabase
        .from('or_issue_types')
        .select('*')
        .eq('is_active', true)
        .order('created_at', { ascending: true })
      if (error) throw error
      setTypes((data || []) as IssueType[])
    } catch (error) {
      console.error('Error loading issue types:', error)
    }
  }

  async function loadIssues() {
    setLoading(true)
    try {
      let query = supabase
        .from('or_issues')
        .select('*')
        .order('created_at', { ascending: false })
      if (fromDate) query = query.gte('created_at', `${fromDate}T00:00:00.000Z`)
      if (toDate) query = query.lte('created_at', `${toDate}T23:59:59.999Z`)
      const { data: issues, error } = await query
      if (error) throw error

      let list = (issues || []) as Issue[]
      if (scope === 'plan') {
        list = list.filter((i) => i.work_order_name != null && String(i.work_order_name).trim() !== '')
      }
      const orderIds = Array.from(new Set(list.map((i) => i.order_id))).filter(Boolean)
      let orderMap = new Map<string, Order>()
      if (orderIds.length > 0) {
        const { data: orders } = await supabase
          .from('or_orders')
          .select('id, bill_no, customer_name, channel_code, work_order_name, admin_user')
          .in('id', orderIds)
        orderMap = new Map((orders || []).map((o: any) => [o.id, o as Order]))
      }
      const creatorIds = Array.from(new Set(list.map((i) => i.created_by))).filter(Boolean)
      let creatorMap = new Map<string, string>()
      if (creatorIds.length > 0) {
        const { data: creators } = await supabase
          .from('us_users')
          .select('id, username')
          .in('id', creatorIds)
        creatorMap = new Map((creators || []).map((u: { id: string; username?: string }) => [u.id, u.username || u.id]))
      }
      const typeMap = new Map(types.map((t) => [t.id, t]))
      let withOrder: IssueWithOrder[] = list.map((i) => ({
        ...i,
        order: orderMap.get(i.order_id),
        type: i.type_id ? typeMap.get(i.type_id) || null : null,
        creatorName: creatorMap.get(i.created_by),
      }))
      // admin-pump / admin-tr: เห็นเฉพาะ issue ของบิลตัวเอง
      // production: เห็นเฉพาะ issue ที่ตัวเองสร้าง หรือเป็นเจ้าของบิล
      // superadmin / admin: เห็นทั้งหมด
      // role อื่นๆ: ไม่เห็นเลย
      if (user?.role === 'admin-pump' || user?.role === 'admin-tr') {
        const me = user.username || user.email || ''
        withOrder = withOrder.filter((i) => (i.order?.admin_user || '') === me)
      } else if (user?.role === 'production') {
        withOrder = withOrder.filter((i) => i.created_by === user.id || (i.order?.admin_user || '') === (user.username || user.email || ''))
      }

      const onList = withOrder.filter((i) => i.status === 'On')
      const closedList = withOrder.filter((i) => i.status === 'Close')
      setIssuesOn(onList)
      setIssuesClosed(closedList)
      onOpenCountChange?.(onList.length)
      setNewIssueCount(0)
      setNewChatCount(0)
      if (user) {
        await loadUnreadCounts([...onList, ...closedList].map((i) => i.id))
      }
    } catch (error) {
      console.error('Error loading issues:', error)
    } finally {
      setLoading(false)
    }
  }

  async function loadUnreadCounts(issueIds: string[]) {
    if (!user || issueIds.length === 0) {
      setUnreadByIssue({})
      return
    }
    try {
      const [{ data: reads }, { data: messages }] = await Promise.all([
        supabase.from('or_issue_reads').select('issue_id, last_read_at').eq('user_id', user.id),
        supabase.from('or_issue_messages').select('issue_id, created_at').in('issue_id', issueIds),
      ])
      const readMap = new Map(
        (reads || []).map((r: any) => [r.issue_id, new Date(r.last_read_at).getTime()])
      )
      const counts: Record<string, number> = {}
      ;(messages || []).forEach((m: { issue_id: string; created_at: string }) => {
        const lastRead = readMap.get(m.issue_id) ?? 0
        const msgTime = new Date(m.created_at).getTime()
        if (msgTime > lastRead) {
          counts[m.issue_id] = (counts[m.issue_id] || 0) + 1
        }
      })
      setUnreadByIssue(counts)
    } catch (error) {
      console.error('Error loading unread counts:', error)
    }
  }

  const isAdminRole = user?.role === 'superadmin' || user?.role === 'admin'

  async function openChat(issue: IssueWithOrder) {
    setChatIssue(issue)
    setChatMessage('')
    setChatLogs([])
    if (!isAdminRole) window.dispatchEvent(new CustomEvent('issue-chat-read'))
    setChatLoading(true)
    try {
      // Mark as read (ข้าม superadmin/admin เพื่อไม่ให้ badge ลด)
      if (user && !isAdminRole) {
        await supabase.from('or_issue_reads').upsert({
          issue_id: issue.id,
          user_id: user.id,
          last_read_at: new Date().toISOString(),
        })
        setUnreadByIssue((prev) => ({ ...prev, [issue.id]: 0 }))
      }
      const { data, error } = await supabase
        .from('or_issue_messages')
        .select('*')
        .eq('issue_id', issue.id)
        .order('created_at', { ascending: true })
      if (error) throw error
      setChatLogs((data || []) as IssueMessage[])
    } catch (error) {
      console.error('Error loading issue messages:', error)
    } finally {
      setChatLoading(false)
    }
  }

  async function sendChat() {
    if (!chatIssue || !user) return
    const message = chatMessage.trim()
    if (!message) return
    setChatSending(true)
    try {
      const payload = {
        issue_id: chatIssue.id,
        sender_id: user.id,
        sender_name: user.username || user.email || 'ผู้ใช้',
        message,
        source_scope: scope,
      }
      const { data, error } = await supabase
        .from('or_issue_messages')
        .insert(payload)
        .select('*')
        .single()
      if (error) throw error
      if (data) {
        setChatLogs((prev) => (prev.some((m) => m.id === (data as IssueMessage).id) ? prev : [...prev, data as IssueMessage]))
      }
      setChatMessage('')
    } catch (error: any) {
      console.error('Error sending issue message:', error)
      alert('เกิดข้อผิดพลาด: ' + (error?.message || error))
    } finally {
      setChatSending(false)
    }
  }

  async function updateIssueStatus(issue: IssueWithOrder, status: 'On' | 'Close') {
    setUpdatingIssue(true)
    try {
      const updates: Partial<Issue> = { status }
      if (status === 'Close') {
        const closedAt = new Date()
        updates.closed_at = closedAt.toISOString()
        updates.duration_minutes = Math.max(0, Math.floor((closedAt.getTime() - new Date(issue.created_at).getTime()) / 60_000))
      }
      if (status === 'On') {
        updates.closed_at = null
        updates.duration_minutes = null
      }
      const { error } = await supabase.from('or_issues').update(updates).eq('id', issue.id)
      if (error) throw error
      setDetailIssue(null)
      await loadIssues()
    } catch (error: any) {
      console.error('Error updating issue status:', error)
      alert('เกิดข้อผิดพลาด: ' + (error?.message || error))
    } finally {
      setUpdatingIssue(false)
    }
  }

  async function loadOrdersForSelectedWorkOrder(name: string) {
    setOrdersForWorkOrder([])
    if (!name) return
    try {
      const { data, error } = await supabase
        .from('or_orders')
        .select('id, bill_no, customer_name, work_order_name')
        .eq('work_order_name', name)
        .order('created_at', { ascending: false })
      if (error) throw error
      setOrdersForWorkOrder((data || []) as Order[])
    } catch (error) {
      console.error('Error loading orders by work order:', error)
    }
  }

  async function createIssue() {
    if (!user) return
    if (!createWorkOrder || !createOrderId || !createTitle.trim()) {
      alert('กรุณากรอกข้อมูลให้ครบ')
      return
    }
    setCreating(true)
    try {
      const payload = {
        order_id: createOrderId,
        work_order_name: createWorkOrder,
        type_id: createTypeId || null,
        title: createTitle.trim(),
        status: 'On',
        created_by: user.id,
      }
      const { error } = await supabase.from('or_issues').insert(payload)
      if (error) throw error
      setCreateOpen(false)
      setCreateOrderId('')
      setCreateTitle('')
      setCreateTypeId('')
      await loadIssues()
    } catch (error: any) {
      console.error('Error creating issue:', error)
      alert('เกิดข้อผิดพลาด: ' + (error?.message || error))
    } finally {
      setCreating(false)
    }
  }

  async function openOrderDetail(issue: IssueWithOrder) {
    if (!issue.order?.id) return
    setDetailLoading(true)
    setDetailOrder(null)
    try {
      const { data, error } = await supabase
        .from('or_orders')
        .select('*, or_order_items(*)')
        .eq('id', issue.order.id)
        .single()
      if (error) throw error
      setDetailOrder(data as Order)
    } catch (error) {
      console.error('Error loading order detail:', error)
      alert('เกิดข้อผิดพลาดในการโหลดรายละเอียดบิล')
    } finally {
      setDetailLoading(false)
    }
  }

  if (loading) {
    return (
      <div className="flex justify-center items-center py-12">
        <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-blue-500" />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-lg shadow px-4 py-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {[
            { key: 'on' as const, label: `New Issue (${issuesOn.length})` },
            { key: 'close' as const, label: `Close Issue (${issuesClosed.length})` },
          ].map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setActiveTab(tab.key)}
              className={`px-4 py-2 rounded-lg text-sm font-medium ${
                activeTab === tab.key ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-sm text-gray-600 font-medium">จาก</label>
          <input
            type="date"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:ring-2 focus:ring-blue-400 focus:border-blue-400"
          />
          <label className="text-sm text-gray-600 font-medium">ถึง</label>
          <input
            type="date"
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:ring-2 focus:ring-blue-400 focus:border-blue-400"
          />
          {scope === 'plan' && (
            <button
              type="button"
              onClick={() => setCreateOpen(true)}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
            >
              เปิด Ticket
            </button>
          )}
        </div>
      </div>
      <div className="bg-white rounded-lg shadow overflow-hidden">
        <div className="divide-y">
          {(activeTab === 'on' ? issuesOn : issuesClosed).length === 0 ? (
            <div className="p-6 text-center text-gray-500">ไม่พบรายการ</div>
          ) : (
            (activeTab === 'on' ? issuesOn : issuesClosed).map((issue) => (
              <div key={issue.id} className="p-5 space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-lg font-bold text-blue-700 truncate">{issue.order?.bill_no || '-'}</div>
                    <div className="text-base text-gray-800 mt-1">
                      <span className="font-semibold text-gray-500">หัวข้อ:</span>{' '}
                      {issue.title}
                    </div>
                  </div>
                  <div className="text-right shrink-0 space-y-1">
                    <div className="text-sm text-gray-500">{formatDateTime(issue.created_at)}</div>
                    <div className="text-center">
                      <div className="text-[10px] text-gray-400 mb-0.5">ระยะเวลาปิด Ticket</div>
                      <div className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-sm font-mono font-bold ${
                        issue.status === 'On'
                          ? 'bg-orange-100 text-orange-700'
                          : 'bg-gray-100 text-gray-600'
                      }`}>
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                        {formatElapsed(issue)}
                      </div>
                    </div>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  {issue.type && (
                    <span
                      className="px-3 py-1.5 rounded-lg font-bold text-white"
                      style={{ backgroundColor: issue.type.color }}
                    >
                      {issue.type.name}
                    </span>
                  )}
                  <span className="px-3 py-1.5 rounded-lg bg-blue-100 text-blue-800 font-medium">
                    ผู้ลงออเดอร์: {issue.order?.admin_user || '-'}
                  </span>
                  <span className="px-3 py-1.5 rounded-lg bg-purple-100 text-purple-800 font-medium">
                    ผู้เปิด Ticket: {issue.creatorName || '-'}
                  </span>
                  {issue.work_order_name && (
                    <span className="px-3 py-1.5 rounded-lg bg-green-100 text-green-800 font-medium">
                      {issue.work_order_name}
                    </span>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setDetailIssue(issue)}
                    className="inline-flex items-center gap-1.5 px-4 py-2 bg-amber-500 text-white rounded-xl text-sm font-semibold hover:bg-amber-600 transition-colors"
                  >
                    <FiCheckCircle className="w-4 h-4" />
                    สถานะ
                  </button>
                  <button
                    type="button"
                    onClick={() => openOrderDetail(issue)}
                    className="inline-flex items-center gap-1.5 px-4 py-2 bg-blue-600 text-white rounded-xl text-sm font-semibold hover:bg-blue-700 transition-colors"
                  >
                    <FiInfo className="w-4 h-4" />
                    รายละเอียด
                  </button>
                  <button
                    type="button"
                    onClick={() => openChat(issue)}
                    className="inline-flex items-center gap-1.5 px-4 py-2 bg-emerald-600 text-white rounded-xl text-sm font-semibold hover:bg-emerald-700 transition-colors"
                  >
                    <FiMessageCircle className="w-4 h-4" />
                    Chat
                  </button>
                  {(unreadByIssue[issue.id] || 0) > 0 && (
                    <span className="min-w-[1.2rem] h-5 px-1.5 flex items-center justify-center rounded-full text-[10px] font-bold bg-red-500 text-white animate-pulse">
                      {unreadByIssue[issue.id]}
                    </span>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      <Modal
        open={!!detailIssue}
        onClose={() => {
          if (!updatingIssue) setDetailIssue(null)
        }}
        contentClassName="max-w-lg w-full"
      >
        {detailIssue && (
          <div className="p-6 space-y-4">
            <div>
              <h3 className="text-lg font-semibold text-gray-900">รายละเอียด Ticket</h3>
              <p className="text-sm text-gray-600 mt-1">{detailIssue.order?.bill_no || '-'}</p>
            </div>
            <div className="text-sm text-gray-700 space-y-1">
              <div>หัวข้อ: <span className="font-medium">{detailIssue.title}</span></div>
              <div>สถานะ: <span className="font-medium">{detailIssue.status}</span></div>
              {detailIssue.work_order_name && <div>ใบงาน: {detailIssue.work_order_name}</div>}
              <div>ผู้เปิดบิล: <span className="font-medium">{detailIssue.order?.admin_user || '-'}</span></div>
              <div>ผู้สร้าง Ticket: <span className="font-medium">{detailIssue.creatorName || '-'}</span></div>
              <div>ระยะเวลา: <span className="font-mono font-bold text-orange-600">{formatElapsed(detailIssue)}</span></div>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">สถานะ Ticket</label>
              <select
                value={detailIssue.status}
                onChange={(e) => setDetailIssue((prev) => (prev ? { ...prev, status: e.target.value as 'On' | 'Close' } : prev))}
                className="w-full px-3 py-2 border rounded-lg bg-white"
              >
                <option value="On">On</option>
                <option value="Close">Close</option>
              </select>
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setDetailIssue(null)}
                disabled={updatingIssue}
                className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50"
              >
                ยกเลิก
              </button>
              <button
                type="button"
                onClick={() => updateIssueStatus(detailIssue, detailIssue.status)}
                disabled={updatingIssue}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
              >
                {updatingIssue ? 'กำลังบันทึก...' : 'บันทึก'}
              </button>
              {detailIssue.status === 'On' && (
                <button
                  type="button"
                  onClick={() => updateIssueStatus(detailIssue, 'Close')}
                  disabled={updatingIssue}
                  className="px-4 py-2 bg-amber-500 text-white rounded-lg hover:bg-amber-600 disabled:opacity-50"
                >
                  ปิด Ticket
                </button>
              )}
            </div>
          </div>
        )}
      </Modal>

      <Modal
        open={!!chatIssue}
        onClose={() => {
          if (!chatSending) setChatIssue(null)
        }}
        contentClassName="max-w-2xl w-full"
      >
        {chatIssue && (
          <div className="flex flex-col max-h-[80vh]">
            <div className="p-4 border-b bg-emerald-600 flex items-center justify-between rounded-t-xl">
              <div>
                <h3 className="text-lg font-semibold text-white flex items-center gap-2">
                  <FiMessageCircle className="w-5 h-5" /> Chat
                </h3>
                <p className="text-sm text-emerald-100">{chatIssue.order?.bill_no || '-'}</p>
              </div>
              <button
                type="button"
                onClick={() => setChatIssue(null)}
                className="px-3 py-1.5 bg-red-600 hover:bg-red-700 text-white rounded-lg text-sm font-semibold transition-colors"
              >
                ปิดหน้าต่าง
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-3 bg-gradient-to-b from-slate-100 to-slate-50">
              {chatLoading ? (
                <div className="flex justify-center items-center py-6">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-emerald-500" />
                </div>
              ) : chatLogs.length === 0 ? (
                <div className="text-center text-gray-500 py-6">ยังไม่มีข้อความ</div>
              ) : (
                chatLogs.map((log) => {
                  const isPlan = log.source_scope === 'plan'
                  const isRight = isPlan
                  const scopeLabel = isPlan ? 'Plan' : 'ออเดอร์'
                  return (
                    <div key={log.id} className={`flex ${isRight ? 'justify-end' : 'justify-start'}`}>
                      <div className={`max-w-[75%] rounded-2xl px-4 py-3 shadow-sm ${
                        isRight
                          ? 'bg-emerald-500 text-white rounded-br-sm'
                          : 'bg-white text-gray-900 border border-gray-200 rounded-bl-sm'
                      }`}>
                        <div className={`flex items-center justify-between gap-3 mb-1 ${isRight ? 'flex-row-reverse' : ''}`}>
                          <span className={`text-xs font-bold ${isRight ? 'text-emerald-100' : 'text-blue-600'}`}>
                            {log.sender_name}
                            <span className={`ml-1.5 px-1.5 py-0.5 rounded text-[10px] ${isRight ? 'bg-emerald-600/50 text-emerald-100' : 'bg-blue-100 text-blue-600'}`}>{scopeLabel}</span>
                          </span>
                          <span className={`text-xs ${isRight ? 'text-emerald-200' : 'text-gray-400'}`}>
                            {formatDateTime(log.created_at)}
                          </span>
                        </div>
                        <div className="text-sm whitespace-pre-wrap leading-relaxed">{log.message}</div>
                      </div>
                    </div>
                  )
                })
              )}
            </div>
            <div className="p-4 border-t bg-white space-y-3">
              <textarea
                value={chatMessage}
                onChange={(e) => setChatMessage(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    if (e.shiftKey) {
                      // Shift+Enter = ขึ้นบรรทัดใหม่ (default behavior)
                      return
                    }
                    if (enterToSend && !e.nativeEvent.isComposing) {
                      e.preventDefault()
                      if (chatMessage.trim() && !chatSending) sendChat()
                    }
                  }
                }}
                rows={3}
                placeholder={enterToSend ? 'พิมพ์ข้อความ... (Enter ส่ง, Shift+Enter ขึ้นบรรทัดใหม่)' : 'พิมพ์ข้อความ...'}
                className="w-full px-4 py-3 border rounded-xl border-gray-300 focus:ring-2 focus:ring-blue-400 focus:border-blue-400 focus:outline-none text-sm bg-gray-50"
              />
              <div className="flex items-center justify-between">
                <label className="inline-flex items-center gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={enterToSend}
                    onChange={(e) => setEnterToSend(e.target.checked)}
                    className="w-4 h-4 rounded border-gray-300 text-emerald-600 focus:ring-emerald-500"
                  />
                  <span className="text-sm text-gray-600">Enter ส่งข้อความ</span>
                </label>
                <button
                  type="button"
                  onClick={sendChat}
                  disabled={chatSending || chatMessage.trim() === ''}
                  className="inline-flex items-center gap-2 px-5 py-2.5 bg-blue-600 text-white rounded-xl hover:bg-blue-700 disabled:opacity-50 font-semibold transition-colors"
                >
                  <FiMessageCircle className="w-4 h-4" />
                  {chatSending ? 'กำลังส่ง...' : 'ส่งข้อความ'}
                </button>
              </div>
            </div>
          </div>
        )}
      </Modal>

      <Modal
        open={!!detailOrder || detailLoading}
        onClose={() => setDetailOrder(null)}
        contentClassName="max-w-5xl w-full"
      >
        {detailLoading ? (
          <div className="flex justify-center items-center py-12">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500" />
          </div>
        ) : detailOrder ? (
          <OrderDetailView order={detailOrder} onClose={() => setDetailOrder(null)} />
        ) : (
          <div className="text-center text-gray-500 py-8">ไม่พบรายละเอียดบิล</div>
        )}
      </Modal>

      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        contentClassName="max-w-lg w-full"
      >
        <div className="p-6 space-y-4">
          <h3 className="text-lg font-semibold text-gray-900">เปิด Ticket</h3>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">ใบงาน</label>
            <select
              value={createWorkOrder}
              onChange={(e) => {
                const next = e.target.value
                setCreateWorkOrder(next)
                setCreateOrderId('')
                loadOrdersForSelectedWorkOrder(next)
              }}
              className="w-full px-3 py-2 border rounded-lg bg-white"
            >
              <option value="">-- เลือกใบงาน --</option>
              {workOrderOptions.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">บิล</label>
            <select
              value={createOrderId}
              onChange={(e) => setCreateOrderId(e.target.value)}
              className="w-full px-3 py-2 border rounded-lg bg-white"
              disabled={!createWorkOrder}
            >
              <option value="">-- เลือกบิล --</option>
              {ordersForWorkOrder.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.bill_no} {o.customer_name ? `(${o.customer_name})` : ''}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">ประเภท</label>
            <select
              value={createTypeId}
              onChange={(e) => setCreateTypeId(e.target.value)}
              className="w-full px-3 py-2 border rounded-lg bg-white"
            >
              <option value="">-- ไม่ระบุ --</option>
              {types.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">หัวข้อ</label>
            <input
              value={createTitle}
              onChange={(e) => setCreateTitle(e.target.value)}
              className="w-full px-3 py-2 border rounded-lg"
              placeholder="เช่น งานด่วน/ต้องแก้ไข"
            />
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setCreateOpen(false)}
              disabled={creating}
              className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50"
            >
              ยกเลิก
            </button>
            <button
              type="button"
              onClick={createIssue}
              disabled={creating}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
            >
              {creating ? 'กำลังบันทึก...' : 'บันทึก'}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  )
}
