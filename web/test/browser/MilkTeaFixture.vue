<script setup lang="ts">
import { ref } from 'vue'
import { useAccountStore } from '../../src/stores/account'
import MilkTeaAutomation from '../../src/views/activity-center/MilkTeaAutomation.vue'
import MilkTeaPage from '../../src/views/activity-center/MilkTeaPage.vue'
import '../../src/styles/activities.css'

const fullPage = new URLSearchParams(location.search).has('full')

const account = useAccountStore()
account.accounts = [{ id: '1', name: '奶茶甲', running: true }, { id: '2', name: '奶茶乙', running: true }]
account.currentAccountId = '1'
const snapshot = ref({ enabled: true, status: 'idle', message: '已领取营业收益', lastRunAt: 1792530000000, nextRunAt: 1792530300000 })
</script>

<template>
  <div v-if="fullPage" data-page-scroll class="fixture-scroll">
    <section class="activities-root">
      <header class="fixture-heading">
        <h1>活动与节令</h1><p>活动开放时间和奖励进度以当前账号为准</p>
      </header>
      <nav class="activity-tabs">
        <button>活动大厅</button><button>节令日历</button>
      </nav>
      <div class="activity-stage">
        <MilkTeaPage />
      </div>
    </section>
  </div>
  <main v-else style="padding: 12px">
    <button data-testid="switch" style="min-height: 44px" @click="account.currentAccountId = account.currentAccountId === '1' ? '2' : '1'">
      切换账号
    </button>
    <MilkTeaAutomation :snapshot="snapshot" />
  </main>
</template>

<style scoped>
.fixture-scroll {
  height: 100dvh;
  overflow: auto;
  padding: 24px 24px 104px;
}
.fixture-heading {
  margin-bottom: 16px;
}
.fixture-heading h1 {
  font-size: 20px;
  font-weight: 700;
}
.fixture-heading p {
  margin-block: 4px;
  font-size: 14px;
}
@media (max-width: 600px) {
  .fixture-scroll {
    padding: 12px 12px 104px;
  }
}
</style>
