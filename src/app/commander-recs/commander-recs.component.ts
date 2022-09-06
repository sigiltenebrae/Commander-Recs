import { Component, OnInit } from '@angular/core';
import {HttpClient} from "@angular/common/http";
import {delay, Subject, takeUntil, timer} from "rxjs";
import * as Scry from "scryfall-sdk";

@Component({
  selector: 'app-commander-recs',
  templateUrl: './commander-recs.component.html',
  styleUrls: ['./commander-recs.component.css']
})
export class CommanderRecsComponent implements OnInit {

  constructor(private http: HttpClient) { }

  private recommendation_data: any = {}; //weighted dictionary of commanders
  public recommendation_count = 3; //how many recommendations to get
  public recommendations: any[] = []; //list of recommendations

  public calc_clock: any;
  private calc_clock_subscribe: any;
  private subject: any; //observable clock

  username = "";
  deckList: any = null;
  decks: any[] = [];
  loading_recs = false;
  done_recs = false;

  public commander_position = 0; //how many commanders have completed calculations (for loading bar)
  public commander_total = 0; //how many commanders there are (for loading bar)
  public weight_position = 0; //how many commanders have completed weights (for loading bar)
  public weight_total = 0; //how many commanders to apply weight calculations to (for loading bar)
  public user_count = 0;
  public approx_users = 0;
  public deck_count = 0;

  public user_randomness = 50; //random chance of selecting a user for calculations (higher means less likely)
  public color_randomness = 25; //how much color ratings impact the weight of a deck
  public theme_randomness = 50; //how much theme ratings impact the weight of a deck / also shifts theme weights to allow less popular themes to be selected
  public partner_randomness = 50; //shifts partner weights to allow less popular partners to be selected

  private colorData: any = {}; //color averages for weight calculations

  ngOnInit(): void {
  }

  public maxSearchTime() {
    return 1200000 - ((this.user_randomness / 100) * 1200000) > 30000 ? 1200000 - ((this.user_randomness / 100) * 1200000): 30000;
  }

  /**
   * Helper function to display timer in readable format
   * @param time_in_seconds
   */
  public secondsToString(time_in_seconds: number) {
    let seconds: string | number = Math.floor(time_in_seconds % 60)
    let minutes: string | number = Math.floor( (time_in_seconds / 60) % 60)
    let hours: string | number = Math.floor((time_in_seconds / (60 * 60)) % 60)
    seconds = (seconds < 10) ? '0' + seconds : seconds;
    minutes = (minutes < 10) ? '0' + minutes : minutes;
    hours = (hours < 10) ? '0' + hours : hours;
    return `${hours}:${minutes}:${seconds}`;
  }

  getDeckList() {
    if (this.username !== "") {
      this.http.get('/archidekt/api/decks/cards/?formats=3&owner=' + this.username).subscribe(async (deck_data: any) => {
        this.deckList = deck_data.results;
        let data = deck_data;
        let page = 2;
        while (data.next) {
          data = await this.http.get('/archidekt/api/decks/cards/?formats=3&owner=' + this.username + '&page=' + page).toPromise();
          this.deckList = this.deckList.concat(data.results);
          page++;
        }
        this.deckList.forEach((deck: any) => {
          deck.play_rating = 3;
          deck.checked = false;
        });
      });
    }
  }

  setAll(checked: boolean) {
    this.deckList.forEach((deck: any) => {
      deck.checked = checked;
    })
  }

  calculateRecs() {
    this.subject = new Subject();
    this.calc_clock_subscribe = timer(1000, 1000);
    timer(1000, 1000).pipe(
      takeUntil(this.subject),
    ).subscribe(val => {
      this.calc_clock = val;
    });

    let commander_promises: any = [];
    this.deckList.forEach((deck: any) => {
      if (deck.checked) {
        commander_promises.push(this.getCommander(deck));
      }
    });
    this.loading_recs = true;
    Promise.all(commander_promises).then(() => {
      this.calculateRecommendations();
    });
  }

  getCommander(deck: any): Promise<void> {
    return new Promise<void>((resolve_commander) => {
      this.http.get('/archidekt/api/decks/' + deck.id + '/').pipe(delay(1000)).subscribe(async (archidektDeckInfo) => {
        let commanders: string[] = [];
        let deckInfo: any = archidektDeckInfo;
        deckInfo.cards.forEach((card: any) => { //need to find the commander
          if (card.categories.includes("Commander")) {
            commanders.push(card.card.oracleCard.name);
          }
        });
        if (commanders.length == 0 || commanders.length > 2) {
          resolve_commander();
        }
        else {
          let out_deck: any = {};
          out_deck.commander = commanders[0];
          out_deck.play_rating = deck.play_rating;
          if (commanders.length == 2) {
            out_deck.partner_commander = commanders[1];
          }
          else {
            out_deck.partner_commander = null;
          }
          this.decks.push(out_deck);
          resolve_commander();
        }
      });
    });
  }

  /**
   * Start the calculations for recommendations
   */
  public calculateRecommendations(): void {

    this.commander_total = this.decks.length;
    this.commander_position = 0;

    let commander_promises: any[] = [];

    this.approx_users = this.commander_total * (100 - this.user_randomness);

    this.decks.forEach((deck) => { commander_promises.push(this.calculateRecommendationsForCommander(deck)); });
    Promise.all(commander_promises).then(() => {
      this.colorData = this.getColorRatings();

      let color_modifiers: any[] = []
      Object.keys(this.recommendation_data).forEach((commander) => { color_modifiers.push(this.weighCommanderByColors(commander)); });
      this.commander_position = this.commander_total;
      this.weight_total = color_modifiers.length;
      Promise.all(color_modifiers).then(() => {
        this.filterDecks().then(() => {
          //add in theme multiplication
          let sortedDeckList = this.sortDecks();
          console.log(sortedDeckList);
          let recommendation_promises: any[] = [];
          for (let j = 0; j < sortedDeckList.length; j++) {
            if (j == this.recommendation_count) {
              break;
            }
            recommendation_promises.push(this.getRecommendationData(sortedDeckList[j].commander));
          }
          Promise.all(recommendation_promises).then(() => {
            console.log('done');
            console.log(this.recommendations);
            this.loading_recs = false;
            this.done_recs = true;
            this.subject.next();
          });
        });
      });
    });
  }

  /**
   * Calculate recommendations for the commander of given deck. Looks at users who have created decks that share a commander
   * with the given commander and runs calculations on them.
   * @param deck deck to compare with.
   */
  private async calculateRecommendationsForCommander(deck: any) {
    return new Promise<void>((resolve_commander) => {
      //setTimeout(() => { resolve_commander(); }, 600000);
      setTimeout(() => { resolve_commander(); }, this.maxSearchTime());
      let creator_promises: any[] = [];

      this.http.get('/archidekt/api/decks/cards/?deckFormat=3&commanders="' + deck.commander + '"&orderBy=-viewCount&pageSize=100').pipe(delay(1000)).subscribe((archidekt_decks) => {
        let linked_decks: any = archidekt_decks;
        if (deck.partner_commander) {
          linked_decks.results.forEach((linked_deck: any) => {
            if ((Math.random() * 100) > this.user_randomness - 1) {
              creator_promises.push(this.getDecksForCreator(linked_deck.owner.username, deck.play_rating / 2));
            }
          });
          this.http.get('/archidekt/api/decks/cards/?deckFormat=3&commanders="' + deck.commander + '"&orderBy=-viewCount&pageSize=100').pipe(delay(1000)).subscribe((archidekt_partner_decks) => {
            let linked_partner_decks: any = archidekt_partner_decks;
            linked_partner_decks.results.forEach((linked_partner_deck: any) => {
              if ((Math.random() * 100) > this.user_randomness - 1) {
                creator_promises.push(this.getDecksForCreator(linked_partner_deck.owner.username, deck.play_rating / 2));
              }
            });
            Promise.all(creator_promises).then(() => {
              this.commander_position++;
              resolve_commander();
            }).catch((err) => {
              console.log(err);
              resolve_commander();
            });
          }, error => {
            Promise.all(creator_promises).then(() => {
              this.commander_position++;
              resolve_commander();
            }).catch((err) => {
              console.log(err);
              resolve_commander();
            });
          }); //Partner commanders have their rating halved to account for mandatory partners.
        } else {
          linked_decks.results.forEach((linked_deck: any) => {
            if ((Math.random() * 100) > this.user_randomness - 1) {
              creator_promises.push(this.getDecksForCreator(linked_deck.owner.username, deck.play_rating));
            }
          });
          Promise.all(creator_promises).then(() => {
            this.commander_position++;
            resolve_commander();
          }).catch((err) => {
            console.log(err);
            resolve_commander();
          });
        }
      }, error => {
        resolve_commander();
      });
    });
  }


  /**
   * Calculate recommendation data using a given deck creator. Looks at the decks built by that creator and adds
   * their score to the dictionary using the play rating.
   * @param username name of the user to search decks for
   * @param playRating rating of the deck that the user was pulled from
   */
  private async getDecksForCreator(username: string, playRating: number) {
    return new Promise<void>((resolve_user) => {
      //setTimeout(() => { this.user_count++; resolve_user();  }, 300000);
      let recommended_promises: any[] = [];

      this.http.get('/archidekt/api/decks/cards/?owner=' + username + '&orderBy=-viewCount&deckFormat=3').pipe(delay(1000)).subscribe(async (recommend_decks) => {
        let recommended_decks: any = recommend_decks;
        let page = 2;
        recommended_decks.results.forEach((recommended_deck: any) => {
          recommended_promises.push(this.getDeckFromServer(recommended_deck.id, playRating));
        });
        while (recommended_decks.next) {
          recommended_decks = await new Promise<any>((res) => {
            this.http.get('/archidekt/api/decks/cards/?owner=' + username + '&orderBy=-viewCount&deckFormat=3&page=' + page).subscribe((deck_res) => {
              res(deck_res);
            }, error => {
              res(null);
            })
          });
          if (recommended_decks) {
            recommended_decks.results.forEach((recommended_deck: any) => {
              recommended_promises.push(this.getDeckFromServer(recommended_deck.id, playRating));
            });
            page++;
          }
          else {
            break;
          }
        }
        Promise.all(recommended_promises).then(() => {
          this.user_count++;
          resolve_user();
        }).catch((err) => {
          console.log(err);
          this.user_count++;
          resolve_user();
        });
      }, error => {
        this.user_count++;
        resolve_user();
      });
    });
  }

  /**
   * Read in deck from api and put the commander in the recommendation dictionary
   * @param deckId deck to pull from server
   * @param playRating rating to apply to the deck in the dictionary
   */
  private async getDeckFromServer(deckId: number, playRating: number) {
    return new Promise<void>((resolve_deck) => {
      setTimeout(() => { resolve_deck(); }, 3000);
      this.http.get('/archidekt/api/decks/' + deckId + '/').pipe(delay(1000)).subscribe((archidektDeckInfo) => {
        let deckInfo: any = archidektDeckInfo;
        deckInfo.cards.forEach(async (card: any) => {
          if (card.categories.includes("Commander")) {
            if (card.card.oracleCard.name !== "Golos, Tireless Pilgrim" &&
              card.card.oracleCard.name !== "Tymna the Weaver" &&
              card.card.oracleCard.name !== "Thrasios, Triton Hero" &&
              card.card.oracleCard.name !== "Vial Smasher the Fierce") {
              if (this.recommendation_data[card.card.oracleCard.name] != null) {
                this.recommendation_data[card.card.oracleCard.name].score += (playRating / 5);
              }
              else {
                this.recommendation_data[card.card.oracleCard.name] =
                  { score: (playRating / 5) };
              }
              /*if (card.card.oracleCard.name.includes("//")) { //TESTING DOUBLE SIDED CARDS
                this.recommendation_data[card.card.oracleCard.name].score *= 30;
              }*/
            }
          }
        });
        this.deck_count++;
        resolve_deck();
      }, (err) => {
        this.deck_count++;
        resolve_deck();
      });
    });
  }

  /**
   * Get image, theme, and partner data for the input commander, to be used for displaying
   * @param commander commander to get data for
   */
  private async getRecommendationData(commander: string) {
    return new Promise<void>(async (resolve_recommendation) => {
      setTimeout(() => { resolve_recommendation(); }, 3000);
      let outData: any = {};
      outData.commander = commander;
      commander = commander.indexOf('//') > -1 ? commander.substring(0, commander.indexOf('//') - 1): commander;
      let cur = await Scry.Cards.byName(commander);
      let cur_prints = await cur.getPrints();
      if (cur_prints) {
        if (cur_prints[0].card_faces && cur_prints[0].card_faces.length > 1) {
          outData.image_url = cur_prints[0].card_faces[0].image_uris?.png;
          outData.image_url_back = cur_prints[0].card_faces[1].image_uris?.png;
        }
        else {
          outData.image_url = cur_prints[0].image_uris?.png;
        }
      }
      else {
        outData.image_url = '';
      }
      let edhrec_name = commander.toLowerCase().replace(/[`~!@#$%^&*()_|+=?;:'",.<>\{\}\[\]\\\/]/gi, '').replace(/\ /g, '-');
      this.http.get('https://json.edhrec.com/v2/commanders/' + edhrec_name + '.json').subscribe(async (edhrec_json) => {
        let edh_data: any = edhrec_json;
        if (edh_data.panels.partnercounts) {
          let partners: any[] = [];
          edh_data.panels.partnercounts.forEach((partner: any) => {
            partners.push(partner.alt);
          });
          outData.partner = (this.assignWeights(partners, "partner")[0].name);
          if (outData.partner) {
            Scry.Cards.byName(outData.partner).then((cur_partner) => {
              //ADD HERE: Filter out the partner if the colors are wrong
              cur_partner.getPrints().then((cur_partner_images) => {
                if (cur_partner_images) {
                  outData.partner_image_url = cur_partner_images[0].image_uris?.png;
                }
                else {
                  outData.partner_image_url = '';
                }
                edhrec_name += '-' + outData.partner.toLowerCase().replace(/[`~!@#$%^&*()_|+=?;:'",.<>\{\}\[\]\\\/]/gi, '').replace(/\ /g, '-');
                this.http.get('https://json.edhrec.com/v2/commanders/' + edhrec_name + '.json').subscribe((edhrec_json_partner) => {
                  edh_data = edhrec_json_partner;
                  if (edh_data.redirect) {
                    this.http.get('https://json.edhrec.com/v2' + edh_data.redirect + '.json').subscribe((edhrec_redirect) => {
                      edh_data = edhrec_redirect;
                      let themes_list: any[] = [];
                      if (edh_data.panels.links) {
                        for (let link of edh_data.panels.links) {
                          if (link.header === "Themes") {
                            link.items.forEach((theme_option: any) => {
                              themes_list.push(theme_option.value);
                            });
                            break;
                          }
                        }
                        outData.theme_rec = this.assignWeights(themes_list, "theme");
                      }
                      else {
                        outData.theme_rec = '';
                      }
                      this.recommendations.push(outData);
                      resolve_recommendation();
                    }, (err) => {
                      outData.theme_rec = '';
                      this.recommendations.push(outData);
                      resolve_recommendation();
                    });
                  }
                  else {
                    let themes_list: any[] = [];
                    if (edh_data.panels.links) {
                      for (let link of edh_data.panels.links) {
                        if (link.header === "Themes") {
                          link.items.forEach((theme_option: any) => {
                            themes_list.push(theme_option.value);
                          });
                          break;
                        }
                      }
                      outData.theme_rec = this.assignWeights(themes_list, "theme");
                    }
                    else {
                      outData.theme_rec = '';
                    }
                    this.recommendations.push(outData);
                    resolve_recommendation();
                  }
                  let colors = "";
                  edh_data.container.json_dict.card.color_identity.forEach((col: string) => {
                    colors += col.toLowerCase();
                  });
                  this.http.get('https://json.edhrec.com/v2/commanders/' + colors + '.json').subscribe((color_themes) => {
                    let edh_color_data: any = color_themes;
                    let tribes_for_color: any = edh_color_data.relatedinfo.tribes;
                    let themes_for_color: any = edh_color_data.relatedinfo.themes;
                    let data_for_color = themes_for_color;
                    data_for_color.sort((a: any, b: any) => (b.count > a.count) ? 1 : -1);
                    let color_theme_list: any[] = [];
                    data_for_color.forEach((color_data: any) => {
                      color_theme_list.push(color_data.name);
                    });
                    outData.subtheme_rec = this.assignWeights(color_theme_list, "theme");
                  }, (e) => {
                    console.log(e);
                    outData.subtheme_rec = '';
                  });
                }, (err) => {
                  console.log(err);
                  outData.theme_rec = '';
                  this.recommendations.push(outData);
                  resolve_recommendation();
                });
              });
            });
          }
        }
        else { //no partner
          let themes_list: any[] = [];
          if (edh_data.panels.links) {
            for (let link of edh_data.panels.links) {
              if (link.header === "Themes") {
                link.items.forEach((theme_option: any) => {
                  themes_list.push(theme_option.value);
                });
                break;
              }
            }
            outData.theme_rec = this.assignWeights(themes_list, "theme");
          }
          else {
            outData.theme_rec = '';
          }
          let colors = "";
          edh_data.container.json_dict.card.color_identity.forEach((col: string) => {
            colors += col.toLowerCase();
          });
          this.http.get('https://json.edhrec.com/v2/commanders/' + colors + '.json').subscribe((color_themes) => {
            let edh_color_data: any = color_themes;
            let tribes_for_color: any = edh_color_data.relatedinfo.tribes;
            let themes_for_color: any = edh_color_data.relatedinfo.themes;
            let data_for_color = themes_for_color;
            data_for_color.sort((a: any, b: any) => (b.count > a.count) ? 1 : -1);
            let color_theme_list: any[] = [];
            data_for_color.forEach((color_data: any) => {
              color_theme_list.push(color_data.name);
            });
            outData.subtheme_rec = this.assignWeights(color_theme_list, "theme");
            this.recommendations.push(outData);
            resolve_recommendation();
          }, (e) => {
            console.log(e);
            outData.subtheme_rec = '';
            this.recommendations.push(outData);
            resolve_recommendation();
          });
        }
      }, (err) => {
        console.log(err);
        outData.theme_rec = '';
        this.recommendations.push(outData);
        resolve_recommendation();
      });
    });
  }

  /**
   * Takes an input string array and outputs a weighted object list based on the order of the string; objects at the
   * beginning of the list have higher weights and objects at the end have lower weights, with inner values curved
   * between them. Higher randomness for the given type brings all values closer to 1.
   * @param to_weigh input array of values to assign weight to
   * @param type whether to use theme or partner randomness slider
   */
  private assignWeights(to_weigh: string[], type: string) {
    let random_factor = 0;
    if (type === "theme") {
      random_factor = this.theme_randomness;
    }
    else if (type === "partner") {
      random_factor = this.partner_randomness
    }

    if (to_weigh) {
      let weighted_data: any = {};
      let x_coeff = 0;
      let factor = (1 - (random_factor / 100));
      for (let i = 0; i < to_weigh.length; i++) {
        x_coeff += Math.pow(factor, i);
      }
      let base = 100 / x_coeff;
      let cur_coeff = 0;
      for(let i = 0; i < to_weigh.length; i++) {
        cur_coeff += Math.pow(factor, i);
        weighted_data[to_weigh[i]] = Math.floor(100 - ((cur_coeff - 1) * base)) / 100;
      }
      //return weighted_themes;
      let weighted_list: any[] = [];
      Object.keys(weighted_data).forEach((name) => {
        let weight = weighted_data[name]; //apply theme ratings to recommended themes
        weight *= Math.pow( 1 - (Math.floor((Math.random() * random_factor)) / 100), (random_factor / 100) ); //apply a degree of randomness to the theme outputs based on theme/partner randomness. Meant to allow for themes/ partners that aren't the most popular to win if there are no ratings for them.
        weighted_list.push(
          {
            name: name,
            weight: weight
          }
        );
      });

      weighted_list.sort((a: any, b: any) => (b.weight > a.weight) ? 1 : -1);
      return weighted_list;
    }
    else {
      return [''];
    }

  }

  /**
   * Use rating data for user's decks to calculate weight factor by color. Not actually doing anything yet.
   */
  private getColorRatings(): any {
    let w = 0; let u = 0; let b = 0; let r = 0; let g = 0;
    let w_play = 0; let u_play = 0; let b_play = 0; let r_play = 0; let g_play = 0;
    this.decks.forEach((deck) => {
      if (deck.colors) {
        if (deck.colors.includes('W')) { w_play += deck.play_rating; w++}
        if (deck.colors.includes('U')) { u_play += deck.play_rating; u++}
        if (deck.colors.includes('B')) { b_play += deck.play_rating; b++}
        if (deck.colors.includes('R')) { r_play += deck.play_rating; r++}
        if (deck.colors.includes('G')) { g_play += deck.play_rating; g++}
      }
    });
    let color_shift = 0.4; //this is meant to shift colors that are "liked" above 1 to increase their weight
    return {
      w: w > 0 ? ((w_play / w) / 5) + color_shift : 0.2 + color_shift,
      u: u > 0 ? ((u_play / u) / 5) + color_shift : 0.2 + color_shift,
      b: b > 0 ? ((b_play / b) / 5) + color_shift: 0.2 + color_shift,
      r: r > 0 ? ((r_play / r) / 5) + color_shift : 0.2 + color_shift,
      g: g > 0 ? ((g_play / g) / 5) + color_shift : 0.2 + color_shift
    };
  }

  /**
   * Apply color weight factor to commander in the dictionary using its colors
   * @param commander commander to shift by weight
   */
  private async weighCommanderByColors(commander: string) {
    return new Promise<void>(async (resolve_colors) => {
      setTimeout(() => { this.weight_position++; resolve_colors()}, 20000);
      if (this.recommendation_data[commander]) {
        Scry.Cards.byName(commander.indexOf('//') > -1 ? commander.substring(0, commander.indexOf('//') - 1): commander).then( (cur) => {
          if (this.recommendation_data[commander]) {
            if (cur.color_identity.includes('W')) { this.recommendation_data[commander].score *=
              Math.pow(this.colorData.w, (1 - (this.color_randomness / 100))) }
            if (cur.color_identity.includes('U')) { this.recommendation_data[commander].score *=
              Math.pow(this.colorData.u, (1 - (this.color_randomness / 100))) }
            if (cur.color_identity.includes('B')) { this.recommendation_data[commander].score *=
              Math.pow(this.colorData.b, (1 - (this.color_randomness / 100))) }
            if (cur.color_identity.includes('R')) { this.recommendation_data[commander].score *=
              Math.pow(this.colorData.r, (1 - (this.color_randomness / 100))) }
            if (cur.color_identity.includes('G')) { this.recommendation_data[commander].score *=
              Math.pow(this.colorData.g, (1 - (this.color_randomness / 100))) }
          }
          this.weight_position++;
          resolve_colors();
        }, (reject) => {
          this.weight_position++;
          resolve_colors();
        });
      }
      else {
        console.log(commander + ' not found');
      }
      this.weight_position++;
      resolve_colors();
    });
  }

  /**
   * Remove decks from the rating dictionary that do not meet the given filters
   */
  private async filterDecks() {
    return new Promise<void>( (resolve_filter) => {
      setTimeout(() => { resolve_filter(); }, 10000);
      this.decks.forEach((deck) => { //Remove the commanders already in use.
        if (this.recommendation_data[deck.commander]) {
          this.recommendation_data[deck.commander] = null;
          if (deck.partner_commander) {
            if (this.recommendation_data[deck.partner_commander]) {
              this.recommendation_data[deck.partner_commander] = null;
            }
          }
        }
      });
       //Remove commanders from the top list
      this.http.get('https://json.edhrec.com/v2/commanders/year.json').subscribe((top_commanders) => {
        let top_list: any = top_commanders;
        this.http.get('https://json.edhrec.com/v2/commanders/week.json').subscribe((top_commanders_2) => {
          let top_list_2: any = top_commanders_2;
          for (let i = 0; i < 25; i++) {
            let top_cmdr = top_list.container.json_dict.cardlists[0].cardviews[i];
            let top_cmdr_2 = top_list_2.container.json_dict.cardlists[0].cardviews[i];
            if (this.recommendation_data[top_cmdr.name] != null) {
              this.recommendation_data[top_cmdr.name] = null;
            }
            if (this.recommendation_data[top_cmdr_2.name] != null) {
              this.recommendation_data[top_cmdr_2.name] = null;
            }
          }
          resolve_filter();
        }, (err) => {
          resolve_filter();
        });
      }, (err) => {
        resolve_filter();
      });
    });
  }

  /**
   * Takes the recommendation dictionary and returns a sorted list of the values in it
   */
  private sortDecks() {
    let sorted_recomendations: any[] = [];
    Object.keys(this.recommendation_data).forEach((commander) => {
      if (this.recommendation_data[commander] != null) {
        sorted_recomendations.push({commander: commander, score: this.recommendation_data[commander].score });
      }
    });
    sorted_recomendations.sort((a, b) => (b.score > a.score) ? 1 : -1);
    return sorted_recomendations;
  }

}
