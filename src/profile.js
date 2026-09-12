// Generated from public-semantic-source.json /engineering/host_retained_session_profile.
// Source SHA-256: 8082f06ae3cbcb0c850d2eb631df331225603e4943cf49c51c1eaae661ff3297
export const retainedProfile = Object.freeze({
  "contract": "kdna.host-retained-read-session/0.1.0",
  "limits": {
    "units": "Bytes are octets. MiB is 1048576 bytes. All caps are hard per retained Host session unless explicitly scoped to a call; configurations may tighten but never raise the maxima.",
    "ttl_ms": {
      "default": 30000,
      "maximum": 300000
    },
    "retained_snapshots_maximum": 1,
    "in_flight_reads_maximum": 1,
    "input_bytes_maximum": 10485760,
    "retained_container_bytes_maximum": 10485760,
    "retained_view_charge_bytes_maximum": 16777216,
    "read_attempts_maximum": 16,
    "validated_request_ids_maximum": 16,
    "issued_handle_records_maximum": 256,
    "issued_handle_charge_bytes_maximum": 1048576,
    "response_bytes_per_call_maximum": 1048576,
    "control_response_bytes_per_call_maximum": 4096,
    "timeout_ms_per_call": {
      "default": 5000,
      "maximum": 30000
    },
    "accounting": "Check capacity before retention, reservation, issuance and delivery. The retained view charge is UTF-8 byte length of plain JSON serialization of the Core inspection data view; it is an accounting charge, not JCS, a semantic digest or precise heap usage. Handle accounting includes each retained issuance record and its bounded serialized charge. Complete final responses remain subject to formal Read byte budgeting. Bounds and safe integer validation precede allocations or timer scheduling.",
    "read_counting": "Every read entry consumes the bounded attempt count, including rejects and timeouts, independently of the validated request-ID set. Failures never reset or renew the count.",
    "handle_accounting": "Conservatively reserve count and UTF-8 serialized metadata charge for newly prepared handles before delivery, then commit the charge after formal successful delivery. Use pending/final result metadata for resource accounting only; do not copy, mutate, delete entries from or replace the Read-owned authority registry. Final provider disposal releases that registry as a whole after pending calls settle.",
    "outer_limits": "Retained calls also preserve existing multipart 12 MiB, request JSON 64 KiB and Core input limits. Read final-envelope, HTTP-frame, retained accounting and total process memory are distinct limits; none proves the others."
  },
  "options": {
    "name": "RetainedReadSessionOptions",
    "closed": true,
    "required": {
      "binding_id": "Identifier",
      "authorization_domain_id": "Identifier",
      "verifyContext": "(context: trusted current server context) => boolean | Promise<boolean>"
    },
    "optional": {
      "ttlMs": {
        "type": "positive UInt",
        "default": 30000,
        "maximum": 300000
      },
      "maxRetainedContainerBytes": {
        "type": "positive UInt",
        "default": 10485760,
        "maximum": 10485760
      },
      "maxRetainedViewBytes": {
        "type": "positive UInt",
        "default": 16777216,
        "maximum": 16777216
      },
      "maxReads": {
        "type": "positive UInt",
        "default": 16,
        "maximum": 16
      },
      "maxHandleRecords": {
        "type": "positive UInt",
        "default": 256,
        "maximum": 256
      },
      "maxHandleRecordBytes": {
        "type": "positive UInt",
        "default": 1048576,
        "maximum": 1048576
      }
    },
    "validation": "Identifier and UInt retain their existing public meanings. Positive UInt additionally excludes zero. maxHandleRecordBytes is the aggregate per-session record byte charge, not a per-record allowance. The effective maxReads also cannot exceed the existing Host lifetime read limit. Omitted optional values take the listed defaults; supplied values must not exceed the maxima."
  }
});
