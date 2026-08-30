import type { SupplierCommitmentsResponse } from "../types";
import { request } from "./_shared";
export const supplierCommitmentsApi={supplierCommitments:(slug:string,startDate:string)=>request<SupplierCommitmentsResponse>(`/api/companies/${encodeURIComponent(slug)}/supplier-commitments?startDate=${encodeURIComponent(startDate)}`).then(r=>r.supplierCommitments)};
