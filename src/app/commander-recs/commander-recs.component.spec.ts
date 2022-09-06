import { ComponentFixture, TestBed } from '@angular/core/testing';

import { CommanderRecsComponent } from './commander-recs.component';

describe('CommanderRecsComponent', () => {
  let component: CommanderRecsComponent;
  let fixture: ComponentFixture<CommanderRecsComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      declarations: [ CommanderRecsComponent ]
    })
    .compileComponents();

    fixture = TestBed.createComponent(CommanderRecsComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
