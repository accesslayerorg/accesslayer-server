export type UploadStatus =
  | "pending"
  | "clean"
  | "review"
  | "rejected";

export type UploadRejectionReason =
  | "type_mismatch"
  | "unsupported_type"
  | "malware_detected"
  | "invalid_image"
  | "image_dimensions"
  | "scan_failed";

export interface UploadFileInput {
  buffer: Buffer;
  declaredMimeType: string;
  originalName: string;
  size: number;
}

export interface UploadScanResult {
  status: UploadStatus;
  detectedMimeType?: string;
  rejectionReason?: UploadRejectionReason;
  sanitizedBuffer?: Buffer;
}

export interface MalwareScanResult {
  infected: boolean;
  scannerAvailable: boolean;
}

export interface MalwareScanner {
  scan(buffer: Buffer): Promise<MalwareScanResult>;
}

export interface ImageSafetyClassifier {
  classify(buffer: Buffer): Promise<{
    flagged: boolean;
  }>;
}