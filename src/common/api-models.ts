import { ApiProperty } from '@nestjs/swagger';

// These classes describe the JSON already returned by the controllers. They do
// not transform responses or expose internal storage keys and model paths.
const nullableText = { type: String, nullable: true } as const;
const nullableNumber = { type: Number, nullable: true } as const;
const dateTime = { type: String, format: 'date-time' } as const;
const nullableDateTime = { ...dateTime, nullable: true } as const;
const integer = { type: 'integer', minimum: 0 } as const;
const nullableInteger = { ...integer, nullable: true } as const;
const boundingBox = {
  type: 'array',
  items: { type: 'number' },
  minItems: 4,
  maxItems: 4,
  nullable: true,
  description: '[x1, y1, x2, y2] in source-image pixels',
} as const;

export class UserResponse {
  @ApiProperty() id!: string;
  @ApiProperty({ format: 'email' }) email!: string;
  @ApiProperty() display_name!: string;
  @ApiProperty({ enum: ['admin', 'user'] }) role!: string;
  @ApiProperty() is_active!: boolean;
  @ApiProperty(dateTime) created_at!: string;
}

export class LoginResponse {
  @ApiProperty() access_token!: string;
  @ApiProperty({ enum: ['bearer'] }) token_type!: string;
  @ApiProperty(dateTime) expires_at!: string;
}

export class MediaResponse {
  @ApiProperty() id!: string;
  @ApiProperty({ description: 'Alias of id; use this value when creating a recognition job.' })
  media_id!: string;
  @ApiProperty() owner_id!: string;
  @ApiProperty() original_name!: string;
  @ApiProperty({ enum: ['image', 'video'] }) media_type!: string;
  @ApiProperty() mime_type!: string;
  @ApiProperty(integer) size_bytes!: number;
  @ApiProperty({ minLength: 64, maxLength: 64 }) sha256!: string;
  @ApiProperty({ ...nullableInteger, minimum: 1 }) width!: number | null;
  @ApiProperty({ ...nullableInteger, minimum: 1 }) height!: number | null;
  @ApiProperty({ ...nullableNumber, minimum: 0 }) duration_seconds!: number | null;
  @ApiProperty(dateTime) uploaded_at!: string;
  @ApiProperty({ description: 'Authenticated relative URL of the original image or video.' })
  content_url!: string;
}

export class AcceptedJobResponse {
  @ApiProperty() job_id!: string;
  @ApiProperty({ enum: ['queued'] }) status!: string;
  @ApiProperty() status_url!: string;
}

export class JobResponse {
  @ApiProperty() id!: string;
  @ApiProperty() media_id!: string;
  @ApiProperty({ enum: ['detect_only', 'recognize'] }) job_kind!: string;
  @ApiProperty({ enum: ['scene', 'plate_crop'] }) input_mode!: string;
  @ApiProperty({ enum: ['queued', 'running', 'succeeded', 'failed'] }) status!: string;
  @ApiProperty({ description: 'Current processing stage; no estimated percentage is implied.' })
  stage!: string;
  @ApiProperty({ type: 'object', additionalProperties: true }) statistics!: Record<string, unknown>;
  @ApiProperty(dateTime) created_at!: string;
  @ApiProperty(nullableDateTime) started_at!: string | null;
  @ApiProperty(nullableDateTime) finished_at!: string | null;
  @ApiProperty(nullableText) error_code!: string | null;
  @ApiProperty(nullableText) error_message!: string | null;
  @ApiProperty(nullableText) pipeline_id!: string | null;
  @ApiProperty(nullableText) pipeline_version!: string | null;
  @ApiProperty({ type: String, enum: ['prepare', 'recognize'], nullable: true })
  pipeline_task!: string | null;
  @ApiProperty() status_url!: string;
}

export class PipelineModelsResponse {
  @ApiProperty(nullableText) detector!: string | null;
  @ApiProperty(nullableText) recognizer!: string | null;
}

export class PipelineResponse {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: ['prepare', 'recognize'] }) task!: string;
  @ApiProperty() name!: string;
  @ApiProperty() version!: string;
  @ApiProperty({ type: [String], enum: ['image', 'video'], isArray: true }) media_types!: string[];
  @ApiProperty({ type: [String], enum: ['scene', 'plate_crop'], isArray: true })
  input_modes!: string[];
  @ApiProperty({ description: 'Required server-side configuration and model files are present.' })
  ready!: boolean;
  @ApiProperty(nullableText) unavailable_reason!: string | null;
  @ApiProperty({ type: PipelineModelsResponse }) models!: PipelineModelsResponse;
  @ApiProperty(nullableText) preprocessing_version!: string | null;
}

export class AppearanceResponse {
  @ApiProperty() id!: string;
  @ApiProperty() job_id!: string;
  @ApiProperty({
    ...nullableText,
    description: 'Track identifier within this job, not a vehicle identity.',
  })
  source_track_id!: string | null;
  @ApiProperty(nullableInteger) first_frame!: number | null;
  @ApiProperty(nullableInteger) last_frame!: number | null;
  @ApiProperty(nullableNumber) start_seconds!: number | null;
  @ApiProperty(nullableNumber) end_seconds!: number | null;
  @ApiProperty(nullableText) machine_text!: string | null;
  @ApiProperty({ enum: ['readable', 'ambiguous', 'unreadable', 'not_run'] })
  machine_status!: string;
  @ApiProperty({
    ...nullableInteger,
    maximum: 5,
    description:
      'Number of agreeing independent OCR readings. Null for joint multiframe inference.',
  })
  agreement_count!: number | null;
  @ApiProperty({
    type: String,
    nullable: true,
    enum: ['single_image', 'per_crop_majority', 'joint_multiframe'],
    description:
      'How the machine prediction was produced; null when recognition was not run or historical provenance is unknown.',
  })
  recognition_method!: string | null;
  @ApiProperty({
    ...nullableText,
    description:
      'Latest review conclusion, otherwise machine text. Null for rejected/unreadable results.',
  })
  effective_text!: string | null;
  @ApiProperty({ enum: ['pending', 'confirmed', 'corrected', 'unreadable', 'rejected'] })
  review_status!: string;
  @ApiProperty(integer) revision!: number;
}

export class SearchResultResponse extends AppearanceResponse {
  @ApiProperty() media_id!: string;
  @ApiProperty(dateTime) uploaded_at!: string;
}

export class DecodingResponse {
  @ApiProperty({ enum: ['greedy', 'beam_plain', 'beam_filter', 'beam_constrained'] })
  decoder!: string;
  @ApiProperty({ ...integer, minimum: 1 }) beam_width!: number;
  @ApiProperty({ description: 'Whether test-time augmentation views were averaged.' })
  use_tta!: boolean;
  @ApiProperty({ description: 'Decoder output; equals raw_text.' }) plate_text!: string;
  @ApiProperty({ description: 'Greedy CTC text before beam search.' }) greedy_text!: string;
  @ApiProperty({
    description: 'plate_text matches Brazilian LLLDDDD or Mercosul LLLDLDD format.',
  })
  format_valid!: boolean;
  @ApiProperty({
    minimum: 0,
    maximum: 1,
    description: 'Geometric mean probability of emitted greedy symbols; heuristic, not calibrated.',
  })
  greedy_symbol_confidence!: number;
  @ApiProperty({ ...nullableNumber, description: 'CTC beam log score; null for greedy.' })
  beam_log_score!: number | null;
  @ApiProperty({
    ...nullableNumber,
    minimum: 0,
    maximum: 1,
    description:
      'exp(beam_log_score / length): relative ranking score used by the notebook threshold (0.80). Not a probability of correctness.',
  })
  beam_confidence_proxy!: number | null;
}

export class PredictionResponse {
  @ApiProperty() id!: string;
  @ApiProperty() detection_id!: string;
  @ApiProperty({ description: 'Prediction input variant, e.g. original or enhanced.' })
  variant!: string;
  @ApiProperty(nullableText) raw_text!: string | null;
  @ApiProperty(nullableText) normalized_text!: string | null;
  @ApiProperty({ ...nullableNumber, minimum: 0, maximum: 1 }) ocr_score!: number | null;
  @ApiProperty({ type: 'array', items: { type: 'number', minimum: 0, maximum: 1 }, nullable: true })
  character_scores!: number[] | null;
  @ApiProperty({
    type: DecodingResponse,
    nullable: true,
    description: 'CTC decoder evidence; null when the recognizer does not report it.',
  })
  decoding!: DecodingResponse | null;
  @ApiProperty({ ...nullableNumber, minimum: 0 }) latency_ms!: number | null;
  @ApiProperty(dateTime) created_at!: string;
}

export class DetectionResponse {
  @ApiProperty() id!: string;
  @ApiProperty() appearance_id!: string;
  @ApiProperty(integer) selected_order!: number;
  @ApiProperty(nullableInteger) frame_index!: number | null;
  @ApiProperty(nullableNumber) timestamp_seconds!: number | null;
  @ApiProperty(nullableText) timestamp_source!: string | null;
  @ApiProperty(boundingBox) bbox!: number[] | null;
  @ApiProperty(boundingBox) crop_bbox!: number[] | null;
  @ApiProperty({ ...nullableNumber, minimum: 0, maximum: 1 }) detection_score!: number | null;
  @ApiProperty({ ...nullableInteger, minimum: 1 }) crop_width!: number | null;
  @ApiProperty({ ...nullableInteger, minimum: 1 }) crop_height!: number | null;
  @ApiProperty() crop_url!: string;
  @ApiProperty(nullableText) frame_url!: string | null;
  @ApiProperty(nullableText) enhanced_url!: string | null;
  @ApiProperty({ type: [PredictionResponse] }) predictions!: PredictionResponse[];
}

export class JointPredictionResponse {
  @ApiProperty() id!: string;
  @ApiProperty() appearance_id!: string;
  @ApiProperty({ description: 'Input variant used by the joint recognizer.' }) variant!: string;
  @ApiProperty(nullableText) raw_text!: string | null;
  @ApiProperty(nullableText) normalized_text!: string | null;
  @ApiProperty({ ...nullableNumber, minimum: 0, maximum: 1 }) ocr_score!: number | null;
  @ApiProperty({ type: 'array', items: { type: 'number', minimum: 0, maximum: 1 }, nullable: true })
  character_scores!: number[] | null;
  @ApiProperty({
    type: 'array',
    minItems: 5,
    maxItems: 5,
    items: { type: 'string', nullable: true },
    description:
      'Evidence detection IDs in model input order; aligned with frame_weights. A null entry indicates unavailable evidence provenance.',
  })
  detection_ids!: (string | null)[];
  @ApiProperty({
    type: 'array',
    minItems: 5,
    maxItems: 5,
    items: { type: 'number', minimum: 0, maximum: 1 },
    nullable: true,
    description:
      'Model quality-fusion weights for the five input frames, not detector confidence or independent OCR votes.',
  })
  frame_weights!: number[] | null;
  @ApiProperty({
    type: DecodingResponse,
    nullable: true,
    description: 'CTC decoder evidence; null when the recognizer does not report it.',
  })
  decoding!: DecodingResponse | null;
  @ApiProperty({ ...nullableNumber, minimum: 0 }) latency_ms!: number | null;
  @ApiProperty(dateTime) created_at!: string;
}

export class ReviewResponse {
  @ApiProperty() id!: string;
  @ApiProperty() appearance_id!: string;
  @ApiProperty() reviewer_id!: string;
  @ApiProperty({ enum: ['confirm', 'correct', 'unreadable', 'reject'] }) action!: string;
  @ApiProperty(nullableText) corrected_text!: string | null;
  @ApiProperty(nullableText) note!: string | null;
  @ApiProperty({ ...integer, minimum: 1 }) revision!: number;
  @ApiProperty(dateTime) created_at!: string;
}

export class ResultDetailResponse extends AppearanceResponse {
  @ApiProperty({ type: [DetectionResponse] }) detections!: DetectionResponse[];
  @ApiProperty({
    type: [JointPredictionResponse],
    description:
      'Joint appearance predictions; empty when recognition was performed independently per crop or not run.',
  })
  predictions!: JointPredictionResponse[];
  @ApiProperty({ type: [ReviewResponse] }) reviews!: ReviewResponse[];
}

export class ErrorResponse {
  @ApiProperty({
    oneOf: [
      { type: 'string' },
      { type: 'array', items: { type: 'string' } },
      {
        type: 'array',
        items: {
          type: 'object',
          required: ['path', 'message'],
          properties: {
            path: { type: 'array', items: { oneOf: [{ type: 'string' }, { type: 'integer' }] } },
            message: { type: 'string' },
          },
        },
      },
    ],
  })
  detail!: string | string[] | { path: (string | number)[]; message: string }[];
}
