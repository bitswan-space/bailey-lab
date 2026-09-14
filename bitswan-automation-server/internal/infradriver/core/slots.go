package core

type SlotDB struct {
	Slot string
	DB   int
}

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

func BackupRecFor(bs *Bitswan, bpSlug string) *BackupRec {
	if bs == nil || bs.Backups == nil {
		return nil
	}
	return bs.Backups[bpSlug]
}

func SlotsFor(rec *BackupRec) map[string]*SlotRec {
	if rec != nil && len(rec.Slots) > 0 {
		return rec.Slots
	}
	one, two := 1, 2
	return map[string]*SlotRec{"blue": {DB: &one}, "green": {DB: &two}}
}

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
