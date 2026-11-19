CREATE TABLE events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','CLOSED')),
  activation_count integer NOT NULL DEFAULT 0 CHECK (activation_count >= 0),
  free_quota_limit integer NOT NULL DEFAULT 1000 CHECK (free_quota_limit = 1000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE staff_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text NOT NULL UNIQUE,
  password_hash text NOT NULL, role text NOT NULL CHECK (role IN ('EVENT_STAFF','VENDOR','FINANCE')),
  active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE vendors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_id uuid NOT NULL REFERENCES events(id),
  name text NOT NULL, active boolean NOT NULL DEFAULT true,
  UNIQUE (event_id,id)
);
CREATE TABLE vendor_staff_assignments (
  staff_user_id uuid NOT NULL REFERENCES staff_users(id), vendor_id uuid NOT NULL REFERENCES vendors(id),
  PRIMARY KEY (staff_user_id,vendor_id)
);
CREATE TABLE sessions (
  token_hash text PRIMARY KEY, staff_user_id uuid NOT NULL REFERENCES staff_users(id),
  csrf_token text NOT NULL, expires_at timestamptz NOT NULL
);
CREATE TABLE qr_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_id uuid NOT NULL REFERENCES events(id),
  name text NOT NULL, quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 5000),
  created_by uuid NOT NULL REFERENCES staff_users(id), created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id,id)
);
CREATE TABLE credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_id uuid NOT NULL REFERENCES events(id),
  batch_id uuid NOT NULL, public_code text NOT NULL, token_hash text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'CREATED' CHECK (status IN ('CREATED','ACTIVATED','VOIDED')),
  activation_sequence integer CHECK (activation_sequence > 0), activated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (event_id,batch_id) REFERENCES qr_batches(event_id,id),
  UNIQUE (event_id,public_code), UNIQUE (event_id,activation_sequence), UNIQUE (event_id,id),
  CHECK ((activation_sequence IS NULL AND activated_at IS NULL AND status <> 'ACTIVATED') OR
    (activation_sequence IS NOT NULL AND activated_at IS NOT NULL AND status <> 'CREATED'))
);
CREATE FUNCTION protect_activation_sequence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.activation_sequence IS NOT NULL AND (NEW.activation_sequence IS DISTINCT FROM OLD.activation_sequence
    OR NEW.event_id IS DISTINCT FROM OLD.event_id OR NEW.activated_at IS DISTINCT FROM OLD.activated_at) THEN
    RAISE EXCEPTION 'activation assignment is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_activation BEFORE UPDATE ON credentials FOR EACH ROW EXECUTE FUNCTION protect_activation_sequence();
CREATE TABLE entitlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_id uuid NOT NULL REFERENCES events(id),
  credential_id uuid NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'AVAILABLE' CHECK (status IN ('AVAILABLE','REDEEMED','REVOKED')),
  granted_at timestamptz NOT NULL DEFAULT now(), redeemed_at timestamptz,
  FOREIGN KEY (event_id,credential_id) REFERENCES credentials(event_id,id),
  UNIQUE (event_id,id,credential_id), CHECK ((status = 'REDEEMED') = (redeemed_at IS NOT NULL))
);
CREATE FUNCTION guard_entitlement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM credentials WHERE id=NEW.credential_id AND event_id=NEW.event_id
    AND status='ACTIVATED' AND activation_sequence BETWEEN 1 AND 1000) THEN
    RAISE EXCEPTION 'credential outside free activation quota' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER entitlement_quota BEFORE INSERT ON entitlements FOR EACH ROW EXECUTE FUNCTION guard_entitlement();
CREATE TABLE redemptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_id uuid NOT NULL REFERENCES events(id),
  entitlement_id uuid NOT NULL UNIQUE, credential_id uuid NOT NULL UNIQUE,
  vendor_id uuid NOT NULL, redeemed_by uuid NOT NULL REFERENCES staff_users(id),
  redeemed_at timestamptz NOT NULL DEFAULT now(), idempotency_key text NOT NULL,
  FOREIGN KEY (event_id,entitlement_id,credential_id) REFERENCES entitlements(event_id,id,credential_id),
  FOREIGN KEY (event_id,vendor_id) REFERENCES vendors(event_id,id)
);
CREATE TABLE idempotency_requests (
  event_id uuid NOT NULL REFERENCES events(id), actor_id uuid NOT NULL REFERENCES staff_users(id),
  operation text NOT NULL, key text NOT NULL, fingerprint text NOT NULL,
  http_status integer, response jsonb, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id,actor_id,operation,key)
);
CREATE TABLE print_artifacts (
  batch_id uuid PRIMARY KEY REFERENCES qr_batches(id), ciphertext text NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '24 hours')
);
CREATE TABLE audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_id uuid NOT NULL REFERENCES events(id),
  actor_id uuid NOT NULL REFERENCES staff_users(id), action text NOT NULL,
  target_id uuid, vendor_id uuid, metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX redemption_vendor_time ON redemptions(event_id,vendor_id,redeemed_at DESC);
CREATE INDEX audit_vendor_time ON audit_logs(event_id,vendor_id,created_at DESC);
CREATE INDEX credential_batch ON credentials(batch_id);
CREATE INDEX session_expiry ON sessions(expires_at);
