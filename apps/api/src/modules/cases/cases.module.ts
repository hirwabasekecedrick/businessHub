import { Module } from '@nestjs/common';
import { CasesController } from './cases.controller';
import { CaseTypesController } from './case-types.controller';
import { CasesService } from './cases.service';
import { CaseAbilityService } from '../../common/abilities/case-ability.service';

@Module({
  controllers: [CasesController, CaseTypesController],
  providers: [CasesService, CaseAbilityService],
  exports: [CasesService, CaseAbilityService],
})
export class CasesModule {}
