package world

import (
	"fmt"
	"testing"
)

func BenchmarkPerceptionConstruction(b *testing.B) {
	for _, n := range []int{100, 1000, 10000} {
		b.Run(fmt.Sprintf("defenders_%d", n), func(b *testing.B) {
			st := WorldState{SettlementID: "settlement", SettlementDefenseHP: 100, SettlementMaxDefenseHP: 100, Defenders: make([]DefenderEntity, n)}
			for i := range st.Defenders {
				st.Defenders[i] = DefenderEntity{PlayerID: fmt.Sprintf("def-%05d", i), HP: 100, MaxHP: 100}
			}
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				_ = buildPerceivedTargets(&st)
			}
		})
	}
}
