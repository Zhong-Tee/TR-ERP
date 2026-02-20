import { useState, useEffect, useCallback } from 'react'
import { FiUpload, FiTrash2, FiX } from 'react-icons/fi'
import {
  upsertEmployee,
  fetchDepartments,
  fetchPositions,
  uploadHRFile,
  getHRFileUrl,
} from '../../lib/hrApi'
import type { HREmployee, HRDepartment, HRPosition } from '../../types'

const BUCKET_PHOTOS = 'hr-photos'
const BUCKET_DOCUMENTS = 'hr-documents'

const DOC_TYPES = [
  'บัตรประชาชน',
  'ใบรับรองแพทย์',
  'หลักฐานการศึกษา',
  'สัญญาจ้าง',
  'อื่นๆ',
] as const

type DocEntry = { name: string; url: string; type: string; uploaded_at: string }

interface EmployeeFormProps {
  employee?: HREmployee
  onSave: () => void
  onClose: () => void
}

const emptyAddress = (): Record<string, string> => ({
  house_no: '',
  moo: '',
  trok: '',
  soi: '',
  road: '',
  tambon: '',
  amphoe: '',
  province: '',
  postal_code: '',
})

export default function EmployeeForm({ employee, onSave, onClose }: EmployeeFormProps) {
  const [activeTab, setActiveTab] = useState(0)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [departments, setDepartments] = useState<HRDepartment[]>([])
  const [positions, setPositions] = useState<HRPosition[]>([])

  const [prefix, setPrefix] = useState('')
  const [first_name, setFirstName] = useState('')
  const [last_name, setLastName] = useState('')
  const [first_name_en, setFirstNameEn] = useState('')
  const [last_name_en, setLastNameEn] = useState('')
  const [nickname, setNickname] = useState('')
  const [citizen_id, setCitizenId] = useState('')
  const [birth_date, setBirthDate] = useState('')
  const [gender, setGender] = useState('')
  const [religion, setReligion] = useState('')
  const [phone, setPhone] = useState('')
  const [emergency_name, setEmergencyName] = useState('')
  const [emergency_phone, setEmergencyPhone] = useState('')
  const [emergency_relationship, setEmergencyRelationship] = useState('')
  const [address, setAddress] = useState<Record<string, string>>(emptyAddress())
  const [photoFile, setPhotoFile] = useState<File | null>(null)
  const [photoPreview, setPhotoPreview] = useState<string | null>(null)

  const [employee_code, setEmployeeCode] = useState('')
  const [department_id, setDepartmentId] = useState('')
  const [position_id, setPositionId] = useState('')
  const [hire_date, setHireDate] = useState('')
  const [probation_end_date, setProbationEndDate] = useState('')
  const [salary, setSalary] = useState<number | ''>('')
  const [employment_status, setEmploymentStatus] = useState<HREmployee['employment_status']>('active')
  const [fingerprint_id_old, setFingerprintIdOld] = useState('')
  const [fingerprint_id_new, setFingerprintIdNew] = useState('')
  const [user_id, setUserId] = useState('')
  const [telegram_chat_id, setTelegramChatId] = useState('')

  const [documents, setDocuments] = useState<DocEntry[]>([])
  const [docUploadType, setDocUploadType] = useState<string>(DOC_TYPES[0])
  const [docUploading, setDocUploading] = useState(false)

  const loadOptions = useCallback(async () => {
    try {
      const [deptRes, posRes] = await Promise.all([
        fetchDepartments(),
        fetchPositions(),
      ])
      setDepartments(deptRes)
      setPositions(posRes)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'โหลดตัวเลือกไม่สำเร็จ')
    }
  }, [])

  useEffect(() => {
    loadOptions()
  }, [loadOptions])

  useEffect(() => {
    if (employee) {
      setPrefix(employee.prefix ?? '')
      setFirstName(employee.first_name ?? '')
      setLastName(employee.last_name ?? '')
      setFirstNameEn(employee.first_name_en ?? '')
      setLastNameEn(employee.last_name_en ?? '')
      setNickname(employee.nickname ?? '')
      setCitizenId(employee.citizen_id ?? '')
      setBirthDate(employee.birth_date ? employee.birth_date.slice(0, 10) : '')
      setGender(employee.gender ?? '')
      setReligion(employee.religion ?? '')
      setPhone(employee.phone ?? '')
      setEmergencyName(employee.emergency_contact?.name ?? '')
      setEmergencyPhone(employee.emergency_contact?.phone ?? '')
      setEmergencyRelationship(employee.emergency_contact?.relationship ?? '')
      setAddress(
        employee.address && typeof employee.address === 'object'
          ? { ...emptyAddress(), ...employee.address }
          : emptyAddress()
      )
      setPhotoPreview(
        employee.photo_url
          ? employee.photo_url.startsWith('http')
            ? employee.photo_url
            : getHRFileUrl(BUCKET_PHOTOS, employee.photo_url)
          : null
      )

      setEmployeeCode(employee.employee_code ?? '')
      setDepartmentId(employee.department_id ?? '')
      setPositionId(employee.position_id ?? '')
      setHireDate(employee.hire_date ? employee.hire_date.slice(0, 10) : '')
      setProbationEndDate(
        employee.probation_end_date ? employee.probation_end_date.slice(0, 10) : ''
      )
      setSalary(employee.salary ?? '')
      setEmploymentStatus(employee.employment_status)
      setFingerprintIdOld(employee.fingerprint_id_old ?? '')
      setFingerprintIdNew(employee.fingerprint_id_new ?? '')
      setUserId(employee.user_id ?? '')
      setTelegramChatId(employee.telegram_chat_id ?? '')
      setDocuments(
        Array.isArray(employee.documents)
          ? employee.documents.map((d) => ({
              name: d.name,
              url: d.url,
              type: d.type,
              uploaded_at: d.uploaded_at,
            }))
          : []
      )
    } else {
      setEmploymentStatus('active')
      setDocuments([])
    }
  }, [employee])

  useEffect(() => {
    if (department_id) {
      fetchPositions(department_id).then(setPositions).catch(() => setPositions([]))
    } else {
      fetchPositions().then(setPositions).catch(() => setPositions([]))
    }
  }, [department_id])

  const handlePhotoChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      setPhotoFile(file)
      const url = URL.createObjectURL(file)
      setPhotoPreview(url)
    }
  }

  const handleDocUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file || !employee?.id) return
    setDocUploading(true)
    setError(null)
    try {
      const path = `employees/${employee.id}/${Date.now()}_${file.name}`
      await uploadHRFile(BUCKET_DOCUMENTS, path, file)
      const newDoc: DocEntry = {
        name: file.name,
        url: path,
        type: docUploadType,
        uploaded_at: new Date().toISOString(),
      }
      setDocuments((prev) => [...prev, newDoc])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'อัปโหลดเอกสารไม่สำเร็จ')
    } finally {
      setDocUploading(false)
      e.target.value = ''
    }
  }

  const removeDocument = (index: number) => {
    setDocuments((prev) => prev.filter((_, i) => i !== index))
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setSaving(true)
    try {
      let photoPath = employee?.photo_url
      if (photoFile && employee?.id) {
        const ext = photoFile.name.split('.').pop() || 'jpg'
        const path = `${employee.id}/photo.${ext}`
        await uploadHRFile(BUCKET_PHOTOS, path, photoFile)
        photoPath = path
      } else if (photoFile && !employee?.id) {
        // New employee: upload after we have id
        // We'll do one save without photo then update with photo
      }

      const payload: Partial<HREmployee> = {
        id: employee?.id,
        employee_code: employee_code || undefined,
        prefix: prefix || undefined,
        first_name: first_name || '',
        last_name: last_name || '',
        first_name_en: first_name_en || undefined,
        last_name_en: last_name_en || undefined,
        nickname: nickname || undefined,
        citizen_id: citizen_id || undefined,
        birth_date: birth_date || undefined,
        gender: gender || undefined,
        religion: religion || undefined,
        phone: phone || undefined,
        emergency_contact:
          emergency_name || emergency_phone || emergency_relationship
            ? {
                name: emergency_name,
                phone: emergency_phone,
                relationship: emergency_relationship,
              }
            : undefined,
        address: Object.values(address).some(Boolean) ? address : undefined,
        department_id: department_id || undefined,
        position_id: position_id || undefined,
        hire_date: hire_date || undefined,
        probation_end_date: probation_end_date || undefined,
        salary: typeof salary === 'number' ? salary : undefined,
        employment_status,
        fingerprint_id_old: fingerprint_id_old || undefined,
        fingerprint_id_new: fingerprint_id_new || undefined,
        user_id: user_id || undefined,
        telegram_chat_id: telegram_chat_id || undefined,
        documents: documents.length ? documents : undefined,
      }

      const saved = await upsertEmployee(payload)

      if (photoFile && saved?.id && !photoPath) {
        const ext = photoFile.name.split('.').pop() || 'jpg'
        const path = `${saved.id}/photo.${ext}`
        await uploadHRFile(BUCKET_PHOTOS, path, photoFile)
        await upsertEmployee({ id: saved.id, photo_url: path })
      } else if (photoPath && saved?.id) {
        await upsertEmployee({ id: saved.id, photo_url: photoPath })
      }

      onSave()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'บันทึกไม่สำเร็จ')
    } finally {
      setSaving(false)
    }
  }

  const tabs = [
    { label: 'ข้อมูลส่วนตัว', index: 0 },
    { label: 'ข้อมูลการทำงาน', index: 1 },
    { label: 'เอกสาร', index: 2 },
  ]

  return (
    <form onSubmit={handleSubmit} className="flex flex-col max-h-[85vh]">
      <div className="flex items-center justify-between p-4 border-b border-gray-200 shrink-0">
        <h2 className="text-lg font-semibold text-gray-900">
          {employee ? 'แก้ไขพนักงาน' : 'เพิ่มพนักงาน'}
        </h2>
        <button
          type="button"
          onClick={onClose}
          className="p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg"
        >
          <FiX className="w-5 h-5" />
        </button>
      </div>

      <div className="flex border-b border-gray-200 shrink-0">
        {tabs.map(({ label, index }) => (
          <button
            key={index}
            type="button"
            onClick={() => setActiveTab(index)}
            className={`px-4 py-3 text-sm font-medium border-b-2 transition ${
              activeTab === index
                ? 'border-emerald-600 text-emerald-700'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {error && (
        <div className="mx-4 mt-2 p-3 bg-red-50 text-red-700 rounded-lg text-sm shrink-0">
          {error}
        </div>
      )}

      <div className="p-4 overflow-y-auto flex-1 min-h-0">
        {activeTab === 0 && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <label className="col-span-2 sm:col-span-1">
                <span className="block text-sm font-medium text-gray-700 mb-1">คำนำหน้า</span>
                <input
                  type="text"
                  value={prefix}
                  onChange={(e) => setPrefix(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
                />
              </label>
              <label>
                <span className="block text-sm font-medium text-gray-700 mb-1">ชื่อ *</span>
                <input
                  type="text"
                  value={first_name}
                  onChange={(e) => setFirstName(e.target.value)}
                  required
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
                />
              </label>
              <label>
                <span className="block text-sm font-medium text-gray-700 mb-1">นามสกุล *</span>
                <input
                  type="text"
                  value={last_name}
                  onChange={(e) => setLastName(e.target.value)}
                  required
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
                />
              </label>
              <label>
                <span className="block text-sm font-medium text-gray-700 mb-1">ชื่อ (อังกฤษ)</span>
                <input
                  type="text"
                  value={first_name_en}
                  onChange={(e) => setFirstNameEn(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
                />
              </label>
              <label>
                <span className="block text-sm font-medium text-gray-700 mb-1">นามสกุล (อังกฤษ)</span>
                <input
                  type="text"
                  value={last_name_en}
                  onChange={(e) => setLastNameEn(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
                />
              </label>
              <label>
                <span className="block text-sm font-medium text-gray-700 mb-1">ชื่อเล่น</span>
                <input
                  type="text"
                  value={nickname}
                  onChange={(e) => setNickname(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
                />
              </label>
              <label>
                <span className="block text-sm font-medium text-gray-700 mb-1">เลขบัตรประชาชน</span>
                <input
                  type="text"
                  value={citizen_id}
                  onChange={(e) => setCitizenId(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
                />
              </label>
              <label>
                <span className="block text-sm font-medium text-gray-700 mb-1">วันเกิด</span>
                <input
                  type="date"
                  value={birth_date}
                  onChange={(e) => setBirthDate(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
                />
              </label>
              <label>
                <span className="block text-sm font-medium text-gray-700 mb-1">เพศ</span>
                <input
                  type="text"
                  value={gender}
                  onChange={(e) => setGender(e.target.value)}
                  placeholder="ชาย / หญิง"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
                />
              </label>
              <label>
                <span className="block text-sm font-medium text-gray-700 mb-1">ศาสนา</span>
                <input
                  type="text"
                  value={religion}
                  onChange={(e) => setReligion(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
                />
              </label>
              <label className="col-span-2">
                <span className="block text-sm font-medium text-gray-700 mb-1">โทรศัพท์</span>
                <input
                  type="text"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
                />
              </label>
            </div>

            <div className="border-t border-gray-200 pt-4">
              <h4 className="text-sm font-semibold text-gray-800 mb-2">ผู้ติดต่อฉุกเฉิน</h4>
              <div className="grid grid-cols-3 gap-4">
                <label>
                  <span className="block text-sm font-medium text-gray-700 mb-1">ชื่อ</span>
                  <input
                    type="text"
                    value={emergency_name}
                    onChange={(e) => setEmergencyName(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
                  />
                </label>
                <label>
                  <span className="block text-sm font-medium text-gray-700 mb-1">โทรศัพท์</span>
                  <input
                    type="text"
                    value={emergency_phone}
                    onChange={(e) => setEmergencyPhone(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
                  />
                </label>
                <label>
                  <span className="block text-sm font-medium text-gray-700 mb-1">ความสัมพันธ์</span>
                  <input
                    type="text"
                    value={emergency_relationship}
                    onChange={(e) => setEmergencyRelationship(e.target.value)}
                    placeholder="บิดา, มารดา, ฯลฯ"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
                  />
                </label>
              </div>
            </div>

            <div className="border-t border-gray-200 pt-4">
              <h4 className="text-sm font-semibold text-gray-800 mb-2">ที่อยู่</h4>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
                {(['house_no', 'moo', 'trok', 'soi', 'road', 'tambon', 'amphoe', 'province', 'postal_code'] as const).map(
                  (key) => (
                    <label key={key}>
                      <span className="block text-sm font-medium text-gray-700 mb-1">
                        {key === 'house_no' && 'บ้านเลขที่'}
                        {key === 'moo' && 'หมู่'}
                        {key === 'trok' && 'ตรอก'}
                        {key === 'soi' && 'ซอย'}
                        {key === 'road' && 'ถนน'}
                        {key === 'tambon' && 'ตำบล/แขวง'}
                        {key === 'amphoe' && 'อำเภอ/เขต'}
                        {key === 'province' && 'จังหวัด'}
                        {key === 'postal_code' && 'รหัสไปรษณีย์'}
                      </span>
                      <input
                        type="text"
                        value={address[key] ?? ''}
                        onChange={(e) => setAddress((prev) => ({ ...prev, [key]: e.target.value }))}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
                      />
                    </label>
                  )
                )}
              </div>
            </div>

            <div className="border-t border-gray-200 pt-4">
              <h4 className="text-sm font-semibold text-gray-800 mb-2">รูปถ่าย</h4>
              <div className="flex items-center gap-4">
                <div className="w-24 h-24 rounded-xl border-2 border-gray-200 overflow-hidden bg-gray-100 flex items-center justify-center">
                  {photoPreview ? (
                    <img
                      src={photoPreview}
                      alt=""
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <span className="text-gray-400 text-sm">ไม่มีรูป</span>
                  )}
                </div>
                <label className="inline-flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white rounded-lg font-medium hover:bg-emerald-700 cursor-pointer">
                  <FiUpload />
                  อัปโหลดรูป
                  <input
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={handlePhotoChange}
                  />
                </label>
              </div>
            </div>
          </div>
        )}

        {activeTab === 1 && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <label>
                <span className="block text-sm font-medium text-gray-700 mb-1">รหัสพนักงาน *</span>
                <input
                  type="text"
                  value={employee_code}
                  onChange={(e) => setEmployeeCode(e.target.value)}
                  required
                  disabled={!!employee?.id}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 disabled:bg-gray-100 disabled:text-gray-500"
                />
              </label>
              <label>
                <span className="block text-sm font-medium text-gray-700 mb-1">แผนก</span>
                <select
                  value={department_id}
                  onChange={(e) => setDepartmentId(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
                >
                  <option value="">-- เลือกแผนก --</option>
                  {departments.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span className="block text-sm font-medium text-gray-700 mb-1">ตำแหน่ง</span>
                <select
                  value={position_id}
                  onChange={(e) => setPositionId(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
                >
                  <option value="">-- เลือกตำแหน่ง --</option>
                  {positions.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span className="block text-sm font-medium text-gray-700 mb-1">วันที่เข้างาน</span>
                <input
                  type="date"
                  value={hire_date}
                  onChange={(e) => setHireDate(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
                />
              </label>
              <label>
                <span className="block text-sm font-medium text-gray-700 mb-1">วันสิ้นสุดทดลองงาน</span>
                <input
                  type="date"
                  value={probation_end_date}
                  onChange={(e) => setProbationEndDate(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
                />
              </label>
              <label>
                <span className="block text-sm font-medium text-gray-700 mb-1">เงินเดือน</span>
                <input
                  type="number"
                  min={0}
                  step={0.01}
                  value={salary === '' ? '' : salary}
                  onChange={(e) =>
                    setSalary(e.target.value === '' ? '' : parseFloat(e.target.value) || 0)
                  }
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
                />
              </label>
              <label>
                <span className="block text-sm font-medium text-gray-700 mb-1">สถานะการจ้าง</span>
                <select
                  value={employment_status}
                  onChange={(e) =>
                    setEmploymentStatus(e.target.value as HREmployee['employment_status'])
                  }
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
                >
                  <option value="active">ปฏิบัติงาน</option>
                  <option value="probation">ทดลองงาน</option>
                  <option value="resigned">ลาออก</option>
                  <option value="terminated">ถูกเลิกจ้าง</option>
                </select>
              </label>
              <label>
                <span className="block text-sm font-medium text-gray-700 mb-1">รหัสลายนิ้วมือ (เก่า)</span>
                <input
                  type="text"
                  value={fingerprint_id_old}
                  onChange={(e) => setFingerprintIdOld(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
                />
              </label>
              <label>
                <span className="block text-sm font-medium text-gray-700 mb-1">รหัสลายนิ้วมือ (ใหม่)</span>
                <input
                  type="text"
                  value={fingerprint_id_new}
                  onChange={(e) => setFingerprintIdNew(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
                />
              </label>
              <label>
                <span className="block text-sm font-medium text-gray-700 mb-1">User ID (ลิงก์ระบบ)</span>
                <input
                  type="text"
                  value={user_id}
                  onChange={(e) => setUserId(e.target.value)}
                  placeholder="UUID ถ้ามี"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
                />
              </label>
              <label>
                <span className="block text-sm font-medium text-gray-700 mb-1">Telegram Chat ID</span>
                <input
                  type="text"
                  value={telegram_chat_id}
                  onChange={(e) => setTelegramChatId(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
                />
              </label>
            </div>
          </div>
        )}

        {activeTab === 2 && (
          <div className="space-y-4">
            <p className="text-sm text-gray-600">
              เอกสารแนบของพนักงาน (อัปโหลดได้หลังจากบันทึกพนักงานแล้ว)
            </p>
            {employee?.id && (
              <div className="flex flex-wrap items-center gap-2">
                <select
                  value={docUploadType}
                  onChange={(e) => setDocUploadType(e.target.value)}
                  className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500"
                >
                  {DOC_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
                <label className="inline-flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white rounded-lg font-medium hover:bg-emerald-700 cursor-pointer disabled:opacity-50">
                  <FiUpload />
                  {docUploading ? 'กำลังอัปโหลด...' : 'อัปโหลดเอกสาร'}
                  <input
                    type="file"
                    className="hidden"
                    disabled={docUploading}
                    onChange={handleDocUpload}
                  />
                </label>
              </div>
            )}
            <ul className="border border-gray-200 rounded-xl divide-y divide-gray-100 overflow-hidden">
              {documents.length === 0 ? (
                <li className="px-4 py-6 text-center text-gray-500 text-sm">ยังไม่มีเอกสารแนบ</li>
              ) : (
                documents.map((doc, i) => (
                  <li
                    key={i}
                    className="flex items-center justify-between gap-2 px-4 py-3 hover:bg-gray-50"
                  >
                    <div className="min-w-0">
                      <span className="font-medium text-gray-900 block truncate">{doc.name}</span>
                      <span className="text-xs text-gray-500">{doc.type}</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => removeDocument(i)}
                      className="p-2 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg shrink-0"
                      title="ลบ"
                    >
                      <FiTrash2 />
                    </button>
                  </li>
                ))
              )}
            </ul>
          </div>
        )}
      </div>

      <div className="flex justify-end gap-2 p-4 border-t border-gray-200 shrink-0">
        <button
          type="button"
          onClick={onClose}
          className="px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50"
        >
          ยกเลิก
        </button>
        <button
          type="submit"
          disabled={saving}
          className="px-6 py-2 bg-emerald-600 text-white rounded-lg font-medium hover:bg-emerald-700 disabled:opacity-50"
        >
          {saving ? 'กำลังบันทึก...' : 'บันทึก'}
        </button>
      </div>
    </form>
  )
}
