CREATE TABLE vistrea_store_meta (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  generation INTEGER NOT NULL CHECK (
    generation >= 0 AND generation <= 9007199254740991
  )
) STRICT;

INSERT INTO vistrea_store_meta (singleton, generation) VALUES (1, 0);

CREATE TABLE vistrea_resources (
  repository TEXT NOT NULL,
  resource_kind TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  revision INTEGER CHECK (
    revision IS NULL OR (revision >= 1 AND revision <= 9007199254740991)
  ),
  ordinal INTEGER CHECK (
    ordinal IS NULL OR (ordinal >= 0 AND ordinal <= 9007199254740991)
  ),
  relation_a TEXT,
  relation_b TEXT,
  relation_c TEXT,
  json TEXT NOT NULL CHECK (json_valid(json)),
  PRIMARY KEY (repository, resource_kind, resource_id)
) STRICT;

CREATE INDEX vistrea_resources_revision
  ON vistrea_resources (repository, resource_kind, revision, resource_id);
CREATE INDEX vistrea_resources_relation_a
  ON vistrea_resources (repository, resource_kind, relation_a, resource_id);
CREATE INDEX vistrea_resources_relation_b
  ON vistrea_resources (repository, resource_kind, relation_b, resource_id);
CREATE INDEX vistrea_resources_relation_c
  ON vistrea_resources (repository, resource_kind, relation_c, resource_id);

CREATE TABLE vistrea_object_refs (
  hash TEXT PRIMARY KEY,
  media_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (
    byte_size >= 0 AND byte_size <= 9007199254740991
  ),
  compression TEXT NOT NULL CHECK (compression IN ('none', 'gzip', 'zstd')),
  json TEXT NOT NULL CHECK (json_valid(json))
) STRICT;

CREATE TABLE vistrea_snapshot_objects (
  snapshot_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (
    ordinal >= 0 AND ordinal <= 9007199254740991
  ),
  object_hash TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, ordinal),
  UNIQUE (snapshot_id, object_hash),
  FOREIGN KEY (object_hash) REFERENCES vistrea_object_refs(hash)
) STRICT;

CREATE INDEX vistrea_snapshot_objects_hash
  ON vistrea_snapshot_objects (object_hash, snapshot_id);

CREATE TABLE vistrea_snapshot_pins (
  snapshot_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, reason)
) STRICT;

CREATE TABLE vistrea_runtime_event_gaps (
  event_epoch_id TEXT NOT NULL,
  first_sequence INTEGER NOT NULL CHECK (
    first_sequence >= 1 AND first_sequence <= 9007199254740991
  ),
  last_sequence INTEGER NOT NULL CHECK (
    last_sequence >= first_sequence AND last_sequence <= 9007199254740991
  ),
  PRIMARY KEY (event_epoch_id, first_sequence, last_sequence)
) STRICT;

CREATE TABLE vistrea_screen_graph_versions (
  selector TEXT PRIMARY KEY,
  screen_graph_id TEXT NOT NULL
) STRICT;

CREATE INDEX vistrea_screen_graph_versions_graph
  ON vistrea_screen_graph_versions (screen_graph_id, selector);

CREATE TABLE vistrea_operation_events (
  operation_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (
    sequence >= 1 AND sequence <= 9007199254740991
  ),
  event_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL,
  json TEXT NOT NULL CHECK (json_valid(json)),
  PRIMARY KEY (operation_id, sequence)
) STRICT;

CREATE TABLE vistrea_operation_results (
  operation_id TEXT PRIMARY KEY,
  result_type TEXT NOT NULL,
  storage TEXT NOT NULL CHECK (storage IN ('inline', 'resource')),
  json TEXT NOT NULL CHECK (json_valid(json))
) STRICT;
