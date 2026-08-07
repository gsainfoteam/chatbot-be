DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM (
			SELECT lower(trim("email")) AS normalized_email
			FROM "admins"
			GROUP BY 1
			HAVING count(*) > 1
		) duplicates
	) THEN
		RAISE EXCEPTION 'Cannot create admins_normalized_email_unique: duplicate lower(trim(email)) values exist in admins';
	END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX "admins_normalized_email_unique" ON "admins" USING btree (lower(trim("email")));
