import { useState, useEffect, useCallback } from 'react'
import { FiFileText, FiExternalLink, FiCheck } from 'react-icons/fi'
import {
  fetchEmployeeByUserId,
  fetchDocumentCategories,
  fetchDocuments,
  fetchDocumentReads,
  markDocumentRead,
  getHRFileUrl,
} from '../../../lib/hrApi'
import { useAuthContext } from '../../../contexts/AuthContext'
import type { HRDocumentCategory, HRDocument } from '../../../types'

const BUCKET = 'hr-docs'

type DocWithCategory = HRDocument & { category?: { name: string } }

export default function EmployeeDocuments() {
  const { user } = useAuthContext()
  const [employee, setEmployee] = useState<{ id: string; department_id?: string } | null>(null)
  const [loading, setLoading] = useState(true)
  const [categories, setCategories] = useState<HRDocumentCategory[]>([])
  const [documents, setDocuments] = useState<DocWithCategory[]>([])
  const [readIds, setReadIds] = useState<Set<string>>(new Set())
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null)
  const [viewingDoc, setViewingDoc] = useState<DocWithCategory | null>(null)
  const [markingId, setMarkingId] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!user?.id) return
    setLoading(true)
    try {
      const emp = await fetchEmployeeByUserId(user.id)
      setEmployee(emp)
      if (!emp) {
        setLoading(false)
        return
      }
      const [cats, reads, docs] = await Promise.all([
        fetchDocumentCategories(),
        fetchDocumentReads(emp.id),
        fetchDocuments({ department_id: emp.department_id ?? undefined, category_id: selectedCategoryId ?? undefined }),
      ])
      setCategories(cats)
      setReadIds(new Set(reads.map((r) => r.document_id)))
      setDocuments(docs)
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }, [user?.id, selectedCategoryId])

  useEffect(() => {
    load()
  }, [load])

  const handleView = (doc: DocWithCategory) => {
    setViewingDoc(doc)
    if (doc.file_url) window.open(getHRFileUrl(BUCKET, doc.file_url), '_blank')
    else if (!doc.content) setViewingDoc(null)
  }

  const handleMarkRead = async (documentId: string) => {
    if (!employee) return
    setMarkingId(documentId)
    try {
      await markDocumentRead(documentId, employee.id)
      setReadIds((prev) => new Set([...prev, documentId]))
      setViewingDoc(null)
    } catch (e) {
      console.error(e)
    } finally {
      setMarkingId(null)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="animate-spin rounded-full h-10 w-10 border-2 border-emerald-500 border-t-transparent" />
      </div>
    )
  }

  if (!employee) {
    return (
      <div className="rounded-2xl bg-white p-6 shadow-sm text-center text-gray-500">
        ไม่พบข้อมูลพนักงาน
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <section>
        <h2 className="text-xl font-semibold text-gray-900 mb-3">เอกสาร</h2>
        <div className="flex gap-2 overflow-x-auto pb-2 -mx-1">
          <button
            type="button"
            onClick={() => setSelectedCategoryId(null)}
            className={`shrink-0 rounded-xl px-4 py-2.5 text-sm font-medium ${selectedCategoryId === null ? 'bg-emerald-600 text-white' : 'bg-white border border-gray-200 text-gray-700'}`}
          >
            ทั้งหมด
          </button>
          {categories.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setSelectedCategoryId(c.id)}
              className={`shrink-0 rounded-xl px-4 py-2.5 text-sm font-medium ${selectedCategoryId === c.id ? 'bg-emerald-600 text-white' : 'bg-white border border-gray-200 text-gray-700'}`}
            >
              {c.name}
            </button>
          ))}
        </div>
      </section>

      <section className="space-y-3">
        {documents.length === 0 ? (
          <div className="rounded-2xl bg-white border border-gray-200 p-8 text-center text-gray-500">
            ไม่มีเอกสารในหมวดนี้
          </div>
        ) : (
          documents.map((doc) => {
            const isRead = readIds.has(doc.id)
            return (
              <div
                key={doc.id}
                className="rounded-2xl bg-white border border-gray-200 shadow-sm overflow-hidden"
              >
                <button
                  type="button"
                  onClick={() => handleView(doc)}
                  className="w-full text-left p-4 active:bg-gray-50"
                >
                  <div className="flex items-start gap-3">
                    <FiFileText className="w-8 h-8 text-emerald-600 shrink-0 mt-0.5" />
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold text-gray-900">{doc.title}</p>
                      {doc.description && <p className="text-sm text-gray-600 mt-0.5 line-clamp-2">{doc.description}</p>}
                      <div className="flex flex-wrap items-center gap-2 mt-2">
                        {doc.category && (
                          <span className="inline-flex rounded-full bg-gray-100 px-2.5 py-0.5 text-xs text-gray-600">
                            {doc.category.name}
                          </span>
                        )}
                        <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${isRead ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'}`}>
                          {isRead ? 'อ่านแล้ว' : 'ยังไม่อ่าน'}
                        </span>
                      </div>
                    </div>
                    <FiExternalLink className="w-5 h-5 text-gray-400 shrink-0" />
                  </div>
                </button>
                {doc.requires_acknowledgment && !isRead && (
                  <div className="px-4 pb-4">
                    <button
                      type="button"
                      onClick={() => handleMarkRead(doc.id)}
                      disabled={markingId === doc.id}
                      className="flex items-center justify-center gap-2 w-full py-3 rounded-xl bg-emerald-600 text-white font-medium disabled:opacity-60"
                    >
                      <FiCheck className="w-5 h-5" />
                      {markingId === doc.id ? 'กำลังบันทึก...' : 'ยืนยันการอ่าน'}
                    </button>
                  </div>
                )}
              </div>
            )
          })
        )}
      </section>

      {viewingDoc && !viewingDoc.file_url && viewingDoc.content && (
        <div className="fixed inset-0 z-50 bg-white overflow-auto">
          <div className="sticky top-0 z-10 flex items-center justify-between px-4 py-3 bg-emerald-600 text-white shadow">
            <h3 className="font-semibold truncate">{viewingDoc.title}</h3>
            <button type="button" onClick={() => setViewingDoc(null)} className="p-2 rounded-lg hover:bg-white/20">
              ปิด
            </button>
          </div>
          <div className="p-4">
            <div className="rounded-xl border border-gray-200 p-4 bg-white text-sm whitespace-pre-wrap">
              {viewingDoc.content}
            </div>
            {viewingDoc.requires_acknowledgment && !readIds.has(viewingDoc.id) && (
              <button
                type="button"
                onClick={() => handleMarkRead(viewingDoc.id)}
                disabled={markingId === viewingDoc.id}
                className="mt-4 flex items-center justify-center gap-2 w-full py-3 rounded-xl bg-emerald-600 text-white font-medium"
              >
                <FiCheck className="w-5 h-5" />
                ยืนยันการอ่าน
              </button>
            )}
          </div>
        </div>
      )}

      {viewingDoc && viewingDoc.file_url && viewingDoc.requires_acknowledgment && !readIds.has(viewingDoc.id) && (
        <div className="fixed bottom-0 left-0 right-0 z-40 p-4 bg-white border-t border-gray-200 shadow-[0_-2px_10px_rgba(0,0,0,0.08)]">
          <p className="text-sm text-gray-600 mb-2">เปิดเอกสารแล้ว กรุณายืนยันการอ่าน</p>
          <div className="flex gap-2">
            <button type="button" onClick={() => setViewingDoc(null)} className="flex-1 py-3 rounded-xl border border-gray-300 text-gray-700 font-medium">
              ปิด
            </button>
            <button
              type="button"
              onClick={() => handleMarkRead(viewingDoc.id)}
              disabled={markingId === viewingDoc.id}
              className="flex-1 flex items-center justify-center gap-2 py-3 rounded-xl bg-emerald-600 text-white font-medium"
            >
              <FiCheck className="w-5 h-5" />
              ยืนยันการอ่าน
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
