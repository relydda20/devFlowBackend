export function mapEventToActivity(event) {
  const { type, timestamp, session_id, file, ...rest } = event;

  const file_path = file && typeof file === 'object' && typeof file.path === 'string'
    ? file.path
    : null;

  const metadata = { ...rest };
  if (file !== undefined) metadata.file = file;

  return {
    session_id,
    event_type: type,
    file_path,
    metadata,
    timestamp,
  };
}
