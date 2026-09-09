package core

// Blue/green slots, read from the declaration.
//
// Which slot is live, which is the disaster-recovery standby, which database
// number each one owns, and which version a promote has pinned onto the idle
// one: all of it is in bitswan.yaml, and both drivers have to read it the same
// way or they disagree about what "production" points at.

// SlotDB pairs a slot with the database number it owns.
type SlotDB struct {
	Slot string
	DB   int
}

// SlotDBPairs is the slots a deployment runs in.
//
// Only production is blue/green; everything else is a single unnamed slot. A
// production deployment with no backups record is also single-slot, because
// there is nothing yet that says which database each slot would own.
func SlotDBPairs(bs *Bitswan, conf *Deployment) []SlotDB {
	if conf.StageOrProduction() != "production" {
		return []SlotDB{{"", 0}}
	}
	bpSlug, _ := DeriveBPAndCopy(conf.RelativePath)
	if bpSlug == "" {
		return []SlotDB{{"", 0}}
	}
	slots := SlotsFor(BackupRecFor(bs, bpSlug))
	var pairs []SlotDB
	for _, s := range AppSlots {
		if sr, ok := slots[s]; ok && sr != nil && sr.DB != nil {
			pairs = append(pairs, SlotDB{s, *sr.DB})
		}
	}
	if len(pairs) == 0 {
		return []SlotDB{{"", 0}}
	}
	return pairs
}

// BackupRecFor is the backups record for one business process, or nil.
func BackupRecFor(bs *Bitswan, bpSlug string) *BackupRec {
	if bs == nil || bs.Backups == nil {
		return nil
	}
	return bs.Backups[bpSlug]
}

// SlotsFor is the slot table, defaulting to blue owning database 1 and green
// owning database 2 — the arrangement a first promote creates.
func SlotsFor(rec *BackupRec) map[string]*SlotRec {
	if rec != nil && len(rec.Slots) > 0 {
		return rec.Slots
	}
	one, two := 1, 2
	return map[string]*SlotRec{"blue": {DB: &one}, "green": {DB: &two}}
}

// LiveSlotFor is the slot production traffic goes to.
func LiveSlotFor(bs *Bitswan, conf *Deployment) string {
	bpSlug, _ := DeriveBPAndCopy(conf.RelativePath)
	rec := BackupRecFor(bs, bpSlug)
	if rec != nil && rec.LiveSlot != "" {
		return rec.LiveSlot
	}
	slots := SlotsFor(rec)
	liveDB := 1
	if rec != nil && rec.LiveDB != nil {
		liveDB = *rec.LiveDB
	}
	for _, s := range AppSlots {
		if sr, ok := slots[s]; ok && sr != nil && sr.DB != nil && *sr.DB == liveDB {
			return s
		}
	}
	return "blue"
}

// DRSlotFor is the standby slot, the one a rehearsal restores into and a swap
// promotes. Empty when there is no second slot to be it.
func DRSlotFor(bs *Bitswan, conf *Deployment) string {
	bpSlug, _ := DeriveBPAndCopy(conf.RelativePath)
	rec := BackupRecFor(bs, bpSlug)
	slots := SlotsFor(rec)
	liveDB := 1
	if rec != nil && rec.LiveDB != nil {
		liveDB = *rec.LiveDB
	}
	standbyDB := 1
	if liveDB == 1 {
		standbyDB = 2
	}
	live := LiveSlotFor(bs, conf)
	for _, s := range AppSlots {
		if sr, ok := slots[s]; ok && sr != nil && sr.DB != nil && *sr.DB == standbyDB && s != live {
			return s
		}
	}
	return ""
}

// EffectiveSlotConf is the deployment config to compile for one slot.
//
// A zero-downtime promote pins a new version onto the idle slot by adding a
// "<base>@<slot>" overlay: same automation, different code. The version-bearing
// fields come from the overlay and everything else from the base, so the two
// slots can run different versions while the ingress still points at the live
// one. Without an overlay — the steady state, and every non-production slot —
// this is the base unchanged.
func EffectiveSlotConf(baseID string, base *Deployment, slot string, deployments map[string]*Deployment) *Deployment {
	if slot == "" {
		return base
	}
	overlay := deployments[baseID+"@"+slot]
	if overlay == nil {
		return base
	}
	eff := *base
	if overlay.Checksum != "" {
		eff.Checksum = overlay.Checksum
	}
	if overlay.Source != "" {
		eff.Source = overlay.Source
	}
	if overlay.RelativePath != "" {
		eff.RelativePath = overlay.RelativePath
	}
	if overlay.Image != "" {
		eff.Image = overlay.Image
	}
	if overlay.TagChecksum != "" {
		eff.TagChecksum = overlay.TagChecksum
	}
	return &eff
}
