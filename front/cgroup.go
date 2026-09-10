package main

import (
	"os"
	"strconv"
	"strings"
)

// defaultMemoryLimitBytes is used when the container limit cannot be detected.
const defaultMemoryLimitBytes int64 = 512 << 20 // 512 MiB

// readFirstValue returns the trimmed content of the first readable path.
func readFirstValue(paths ...string) (string, bool) {
	for _, p := range paths {
		b, err := os.ReadFile(p)
		if err != nil {
			continue
		}
		if s := strings.TrimSpace(string(b)); s != "" {
			return s, true
		}
	}
	return "", false
}

// detectMemoryLimitBytes reads the cgroup memory limit (v2 first, then v1).
//
// The value is what the orchestrator actually enforces, which is strictly more
// trustworthy than anything a user could declare by hand.
func detectMemoryLimitBytes() int64 {
	v, ok := readFirstValue(
		"/sys/fs/cgroup/memory.max",                   // cgroup v2
		"/sys/fs/cgroup/memory/memory.limit_in_bytes", // cgroup v1
	)
	if !ok {
		return defaultMemoryLimitBytes
	}
	if v == "max" {
		return defaultMemoryLimitBytes
	}
	n, err := strconv.ParseInt(v, 10, 64)
	// cgroup v1 reports a huge sentinel value when the limit is unlimited.
	if err != nil || n <= 0 || n >= 1<<62 {
		return defaultMemoryLimitBytes
	}
	return n
}

// detectCPUQuota returns the effective CPU quota in whole cores.
// It returns 0 when the quota is unlimited or unknown.
func detectCPUQuota() float64 {
	// cgroup v2: "<quota> <period>" or "max <period>"
	if v, ok := readFirstValue("/sys/fs/cgroup/cpu.max"); ok {
		f := strings.Fields(v)
		if len(f) == 2 && f[0] != "max" {
			quota, err1 := strconv.ParseFloat(f[0], 64)
			period, err2 := strconv.ParseFloat(f[1], 64)
			if err1 == nil && err2 == nil && quota > 0 && period > 0 {
				return quota / period
			}
		}
		return 0
	}
	// cgroup v1
	qs, ok1 := readFirstValue("/sys/fs/cgroup/cpu/cpu.cfs_quota_us")
	ps, ok2 := readFirstValue("/sys/fs/cgroup/cpu/cpu.cfs_period_us")
	if ok1 && ok2 {
		quota, err1 := strconv.ParseFloat(qs, 64)
		period, err2 := strconv.ParseFloat(ps, 64)
		if err1 == nil && err2 == nil && quota > 0 && period > 0 {
			return quota / period
		}
	}
	return 0
}
